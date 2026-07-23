// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {SignatureCheckerLite} from "../libraries/SignatureCheckerLite.sol";
import {LegacyRouter} from "../common/LegacyRouter.sol";
import {EOALegacyFactory} from "../common/EOALegacyFactory.sol";
import {ITransferEOALegacy} from "../interfaces/ITransferLegacyEOAContract.sol";
import {IPremiumLegacy} from "../interfaces/IPremiumLegacy.sol";
import {TransferLegacyStruct} from "../libraries/TransferLegacyStruct.sol";
import {IEIP712LegacyVerifier} from "../interfaces/IEIP712LegacyVerifier.sol";
import {IPremiumSetting} from "../interfaces/IPremiumSetting.sol";
import {IPayment} from "../interfaces/IPayment.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {IAllowanceTransfer} from "../interfaces/IAllowanceTransfer.sol";

contract TransferEOALegacyRouter is LegacyRouter, EOALegacyFactory, Initializable {
  address public premiumSetting;
  IEIP712LegacyVerifier public verifier;
  address public paymentContract;
  address public uniswapRouter;
  address public weth;
  bytes public legacyCreationCode;
  address private _codeAdmin;

  // EIP-1167 minimal-proxy implementation. When set (non-zero), new legacies are
  // created as clones pointing at this address instead of deploying the full
  // `legacyCreationCode` bytecode. Existing legacies are unaffected — they remain
  // full, independent contracts.
  address public legacyImplementation;

  // ─── Create-flow v2: sponsored ("…For") entrypoints ──────────────────────
  // Per-signer sequential nonce for the gas-sponsored `activeLegacyFor` /
  // `activeAliveFor` entrypoints. APPENDED at the end of router storage — this
  // is the only new state added by the sponsored sub-track, so the layout stays
  // append-only and needs no reinitializer (the mapping is auto-zero). See
  // docs/plans/create-flow-v2.md §12a "Decisions locked".
  mapping(address => uint256) public sponsorNonce;

  // Per-legacy owner opt-out for gas-sponsored claims. APPENDED after
  // `sponsorNonce` (layout-safe, auto-zero). Default `false` = sponsored claims
  // ENABLED, because gasless claim is the highest-impact UX win and the
  // beneficiary always authorizes their own claim. An owner who wants to forbid
  // third-party relaying (e.g. a B2B/legal setup) flips this true via
  // `setSponsoredClaimsEnabled`; beneficiaries then simply fall back to the
  // always-available direct `activeLegacy`. The check-in path (`activeAliveFor`)
  // is intentionally NOT gated here — it already requires the owner's own fresh
  // signature per call, so it is inherently opt-in. See create-flow-v2.md §12a
  // "Founder review (2026-06-19)".
  mapping(uint256 => bool) public sponsoredClaimsDisabled;

  // EIP-712 typed-data constants (compile-time — occupy no storage slots).
  // The domain is recomputed per call from `block.chainid + address(this)` so
  // a signed intent can never be replayed cross-chain or against a different
  // router. `verifyingContract` is this router. NOTE: the name/version string
  // literals returned by `eip712Domain()` (ERC-5267) must stay in sync with
  // the hashes below.
  bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
  bytes32 private constant _EIP712_NAME_HASH = keccak256(bytes("10102 Legacy Sponsored"));
  bytes32 private constant _EIP712_VERSION_HASH = keccak256(bytes("1"));
  bytes32 private constant CLAIM_AUTH_TYPEHASH =
    keccak256("ClaimAuth(address beneficiary,uint256 legacyId,bytes32 assetsHash,bool isETH,uint256 nonce,uint256 deadline)");
  bytes32 private constant CHECKIN_AUTH_TYPEHASH =
    keccak256("CheckInAuth(address owner,uint256 legacyId,uint256 nonce,uint256 deadline)");

  /// @notice Beneficiary's signed authorization for a gas-sponsored claim.
  /// `beneficiary` is the recovered EIP-712 signer; funds only ever go to that
  /// beneficiary's own allocation, so any relayer may submit it (permissionless).
  struct ClaimAuth {
    address beneficiary;
    uint256 nonce;
    uint256 deadline;
    bytes signature;
  }

  /// @notice Owner's signed authorization for a gas-sponsored inactivity-timer
  /// reset. `owner` is the recovered signer; only their own legacy's timer is
  /// touched. Single-shot (consumed once via the sequential nonce).
  struct CheckInAuth {
    address owner;
    uint256 nonce;
    uint256 deadline;
    bytes signature;
  }

  // ─── Create-flow v2: Permit2 single-confirm create ───────────────────────
  // Canonical Permit2 (same address on every EVM chain, CREATE2-deployed).
  // Hardcoded per create-flow-v2.md §6.2 — no legitimate reason to point at a
  // non-canonical deployment, and a configurable slot would be an apocalyptic
  // misconfiguration risk. Compile-time constant: no storage, no reinitializer.
  IAllowanceTransfer internal constant PERMIT2 =
    IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

  /// @notice The creator's signed Permit2 AllowanceTransfer batch — one
  /// off-chain signature that replaces the N per-token `approve` transactions
  /// of the v1 create flow. `permitBatch.spender` MUST be the new legacy's
  /// address (CREATE2-predictable via `getNextLegacyAddress` before the tx).
  /// Pass `details.length == 0` to opt out (old-school direct approvals keep
  /// working — the claim path accepts both). See create-flow-v2.md §6.8.
  struct Permit2CreateBundle {
    IAllowanceTransfer.PermitBatch permitBatch;
    bytes signature;
  }

  /* Error */
  error NumBeneficiariesInvalid();
  error NumAssetsInvalid();
  error DistributionsInvalid();
  error ActivationTriggerInvalid();
  error SenderIsCreatedLegacy(address);
  error OnlyBeneficaries();
  error CannotClaim();
  error InvalidSwapSettings();
  error NotCodeAdmin();
  error EmptyCode();
  error OnlyOwner();
  error LegacyStillActive();
  error SponsorshipExpired();
  error InvalidSponsorNonce();
  error InvalidSponsorSignature();
  error SponsoredClaimsDisabled();
  error Permit2SpenderMismatch();

  modifier onlyCodeAdmin() {
    if (msg.sender != _codeAdmin) revert NotCodeAdmin();
    _;
  }

  /* Struct */
  struct LegacyMainConfig {
    string name;
    string note;
    string[] nickNames;
    TransferLegacyStruct.Distribution[] distributions;
  }

  /* Event */
  // TransferEOALegacyCreated (v1, carried LegacyMainConfig incl. PII) was
  // retired by the create-flow-v2 PII strip — both create paths now emit
  // TransferEOALegacyCreatedV2 below. Subgraph v2 (§9) indexes the new event.
  event TransferEOALegacyConfigUpdated(
    uint256 indexed legacyId,
    LegacyMainConfig mainConfig,
    TransferLegacyStruct.LegacyExtraConfig extraConfig,
    uint256 timestamp
  );
  event TransferEOALegacyDistributionUpdated(
    uint256 indexed legacyId,
    string[] nickNames,
    TransferLegacyStruct.Distribution[] distributions,
    uint256 timestamp
  );
  event TransferEOALegacyTriggerUpdated(uint256 indexed legacyId, uint128 lackOfOutgoingTxRange, uint256 timestamp);
  event TransferEOALegacyActivated(uint256 indexed legacyId, uint8 layer, uint256 timestamp);
  event TransferEOALegacyActivedAlive(uint256 indexed legacyId, uint256 timestamp);
  event TransferEOALegacyDeleted(uint256 indexed legacyId, uint256 timestamp);
  event TransferEOALegacyLayer23DistributionUpdated(
    uint256 indexed legacyId,
    uint8 layer,
    string nickNames,
    TransferLegacyStruct.Distribution distribution,
    uint256 timestamp
  );
  event TransferEOALegacyLayer23Created(uint256 indexed legacyId, uint8 layer, TransferLegacyStruct.Distribution distribution, string nickName);
  event EmailOwnerResetNotCompleted(address legacyAddress);
  /// @notice Emitted when the Phase B transfer-activation notify (PremiumSetting
  /// .notifyActivatedTransfer) reverted. The claim itself succeeded — only the
  /// off-chain reminder signal degraded.
  event EmailActivatedNotCompleted(address legacyAddress);
  /// @notice Emitted when post-create premium wiring (private code +
  /// Chainlink Automation cronjob registration) failed for a legacy.
  /// The legacy itself was created successfully — only the premium
  /// reminder layer degraded. Off-chain ops can read this event to
  /// surface degraded-mode legacies for follow-up.
  event PrivateCodeSetupNotCompleted(address legacyAddress);
  event TransferEOALegacyAutoSwapped(uint256 indexed legacyId, address storageToken, uint256 ethAmount, uint256 timestamp);
  event TransferEOALegacyUnswapped(uint256 indexed legacyId, address storageToken, uint256 tokenAmount, uint256 timestamp);
  event TransferEOALegacyActivatedWithUnswap(uint256 indexed legacyId, uint8 layer, uint256 timestamp);
  event TransferEOALegacyCreateFlagReleased(uint256 indexed legacyId, address indexed owner, uint256 timestamp);
  /// @notice A beneficiary's claim was relayed on their behalf (gas-sponsored).
  /// The standard `TransferEOALegacyActivated` is also emitted for this legacy.
  event TransferEOALegacyClaimedFor(uint256 indexed legacyId, address indexed beneficiary, address indexed relayer, uint256 timestamp);
  /// @notice An owner's inactivity-timer reset was relayed on their behalf.
  /// The standard `TransferEOALegacyActivedAlive` is also emitted for this legacy.
  event TransferEOALegacyCheckedInFor(uint256 indexed legacyId, address indexed owner, address indexed relayer, uint256 timestamp);
  /// @notice The legacy owner toggled whether gas-sponsored claims are allowed
  /// for this legacy. `enabled == false` forces beneficiaries onto the direct
  /// `activeLegacy` path. Direct claims are unaffected either way.
  event SponsoredClaimsConfigured(uint256 indexed legacyId, address indexed owner, bool enabled);
  /// @notice `signer` voluntarily invalidated their current sponsor nonce
  /// (`invalidated`), cancelling any outstanding signed-but-unrelayed
  /// sponsored authorization carrying that nonce.
  event SponsorNonceInvalidated(address indexed signer, uint256 invalidated);
  /// @notice PII-free v2 create event: no name, no note, no nicknames — those
  /// live in the off-chain metadata API (create-flow-v2.md §7). The subgraph
  /// indexes creator → legacy edges + claim-relevant config from this alone.
  event TransferEOALegacyCreatedV2(
    uint256 indexed legacyId,
    address indexed legacyAddress,
    address indexed creator,
    TransferLegacyStruct.Distribution[] distributions,
    TransferLegacyStruct.LegacyExtraConfig extraConfig,
    uint256 timestamp
  );

    constructor () {
    _disableInitializers();
  }

  function initialize(
    address _deployerContract,
    address _premiumSetting,
    address _verifier,
    address _paymentContract,
    address router_,
    address weth_
  ) external initializer {
    if (
      _deployerContract == address(0) ||
      _premiumSetting == address(0) ||
      _verifier == address(0) ||
      _paymentContract == address(0) ||
      router_ == address(0) ||
      weth_ == address(0)
    ) revert InvalidInitialization();
    legacyDeployerContract = _deployerContract;
    premiumSetting = _premiumSetting;
    verifier = IEIP712LegacyVerifier(_verifier);
    paymentContract = _paymentContract;
    uniswapRouter = router_;
    weth = weth_;
  }

  function initializeV2(address codeAdmin_) external reinitializer(3) {
    if (codeAdmin_ == address(0)) revert InvalidInitialization();
    _codeAdmin = codeAdmin_;
  }

  // Additional rotation path for proxies whose `_initialized` counter has
  // already advanced past 3 due to a prior reinitialization cycle performed on
  // an earlier implementation. Use this when `initializeV2` is no longer
  // callable (e.g. mainnet as of the EIP-1167 upgrade). Must be called
  // atomically with the proxy upgrade (e.g. via `admin.upgradeAndCall`) to
  // prevent any window for front-running.
  function initializeV3(address codeAdmin_) external reinitializer(4) {
    if (codeAdmin_ == address(0)) revert InvalidInitialization();
    _codeAdmin = codeAdmin_;
  }


  function setLegacyCreationCode(bytes calldata code_) external onlyCodeAdmin {
    if (code_.length == 0) revert EmptyCode();
    legacyCreationCode = code_;
  }

  /**
   * @dev Point new legacies at an EIP-1167 minimal-proxy implementation. Once set,
   * `createLegacy` deploys ~45-byte clones (~40k gas) instead of the full ~18KB
   * bytecode (~6M gas). Pass `address(0)` to fall back to the legacy bytecode path.
   * Existing legacies are unaffected by this change.
   */
  function setLegacyImplementation(address impl_) external onlyCodeAdmin {
    legacyImplementation = impl_;
  }

  /**
   * @dev Get next legacy address that would be created for a sender. Uses the
   * clone prediction when `legacyImplementation` is set, otherwise falls back to
   * the creation-code prediction.
   */
  function getNextLegacyAddress(address sender_) external view returns (address) {
    if (legacyImplementation != address(0)) {
      return _getNextCloneAddress(legacyImplementation, sender_);
    }
    return _getNextAddress(legacyCreationCode, sender_);
  }

  function checkActiveLegacy(uint256 legacyId_) external view returns (bool) {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    return ITransferEOALegacy(legacyAddress).checkActiveLegacy();
  }

  /**
   * @dev v1 compatibility shim — DEPRECATED, kept so pre-v2 frontends keep
   * working (create-flow-v2.md §5.2). Since the clone-impl PII strip (§5.1),
   * `mainConfig_.name` / `.note` / `.nickNames` and `nickName2` / `nickName3`
   * are accepted but IGNORED: no PII is stored or emitted anywhere on-chain;
   * that metadata belongs to the off-chain metadata API (§7). Emits the same
   * PII-free `TransferEOALegacyCreatedV2` event as the v2 path. Callers get
   * none of the Permit2 single-confirm wins — use `createLegacyV2`.
   */
  function createLegacy(
    LegacyMainConfig calldata mainConfig_,
    TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    string calldata /* nickName2 — ignored, see above */,
    string calldata /* nickName3 — ignored, see above */,
    uint256 signatureTimestamp,
    bytes calldata agreementSignature
  ) external returns (address) {
    // Preserve v1 input validation exactly (incl. the nickNames length match)
    // so malformed pre-v2 calls fail the same way they always did.
    if (mainConfig_.distributions.length != mainConfig_.nickNames.length || mainConfig_.distributions.length == 0) revert DistributionsInvalid();
    (, address legacyAddress) = _createLegacyCore(
      mainConfig_.distributions,
      extraConfig_,
      layer2Distribution_,
      layer3Distribution_,
      signatureTimestamp,
      agreementSignature
    );
    return legacyAddress;
  }

  /**
   * @dev Create-flow v2 (create-flow-v2.md §5.2 / §6.8): PII-free,
   * single-confirm create.
   *
   * - No name / note / nicknames — those live in the off-chain metadata API.
   * - `permit2_` carries the creator's signed Permit2 AllowanceTransfer batch
   *   with the new legacy as `spender`. The router registers it via
   *   `PERMIT2.permit` in the same tx — consuming the signature immediately
   *   (fresh `sigDeadline`, no dangling authorization) and writing the
   *   allowances into Permit2's storage. At claim time the clone pulls
   *   through Permit2 exactly like it pulls through direct allowances; the
   *   owner keeps full custody and use of their assets meanwhile, and can
   *   revoke anytime via Permit2's `lockdown` / `approve(0)`.
   *
   * Security: `permitBatch.spender` must equal the freshly deployed legacy —
   * anything else reverts (`Permit2SpenderMismatch`), so a bundle can never
   * point the creator's allowances at a different spender. Permit2 itself
   * verifies the signature against `msg.sender` (the creator), enforces
   * `sigDeadline`, and burns the per-(owner,token,spender) nonce.
   */
  function createLegacyV2(
    TransferLegacyStruct.Distribution[] calldata distributions_,
    TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    Permit2CreateBundle calldata permit2_,
    uint256 signatureTimestamp,
    bytes calldata agreementSignature
  ) external returns (address) {
    if (distributions_.length == 0) revert DistributionsInvalid();

    (, address legacyAddress) = _createLegacyCore(
      distributions_,
      extraConfig_,
      layer2Distribution_,
      layer3Distribution_,
      signatureTimestamp,
      agreementSignature
    );

    // Register the creator's batch allowance in Permit2 with the new legacy
    // as spender. A bad bundle reverts the whole create atomically.
    if (permit2_.permitBatch.details.length != 0) {
      if (permit2_.permitBatch.spender != legacyAddress) revert Permit2SpenderMismatch();
      PERMIT2.permit(msg.sender, permit2_.permitBatch, permit2_.signature);
    }

    return legacyAddress;
  }

  /**
   * @dev Shared create path for `createLegacy` (v1 shim) and `createLegacyV2`.
   * PII-free by construction: the clone initializer no longer accepts
   * name/nickname params (§5.1) and the only create event is the PII-free
   * `TransferEOALegacyCreatedV2`.
   */
  function _createLegacyCore(
    TransferLegacyStruct.Distribution[] calldata distributions_,
    TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    uint256 signatureTimestamp,
    bytes calldata agreementSignature
  ) internal returns (uint256 newLegacyId, address legacyAddress) {
    if (extraConfig_.lackOfOutgoingTxRange == 0) revert ActivationTriggerInvalid();
    //Check if msg.sender has already created a legacy
    if (_isCreateLegacy(msg.sender)) revert SenderIsCreatedLegacy(msg.sender);

    // Create new legacy contract. Clone path (EIP-1167) when an implementation
    // is configured, otherwise full-bytecode deploy for back-compat.
    (newLegacyId, legacyAddress) = legacyImplementation != address(0)
      ? _cloneLegacy(legacyImplementation, msg.sender)
      : _createLegacy(legacyCreationCode, msg.sender);

    //Verify + store user agreement signature (TOS stays a first-class on-chain
    //artifact — see create-flow-v2.md §6.5)
    verifier.storeLegacyAgreement(msg.sender, legacyAddress, signatureTimestamp, agreementSignature);

    uint256 numberOfBeneficiaries = ITransferEOALegacy(legacyAddress).initialize(
      newLegacyId,
      msg.sender,
      distributions_,
      extraConfig_,
      layer2Distribution_,
      layer3Distribution_,
      premiumSetting,
      paymentContract,
      uniswapRouter,
      weth
    );

    // Check beneficiary limit
    if (!_checkNumBeneficiariesLimit(numberOfBeneficiaries)) revert NumBeneficiariesInvalid();

    TransferLegacyStruct.LegacyExtraConfig memory _legacyExtraConfig = TransferLegacyStruct.LegacyExtraConfig({
      lackOfOutgoingTxRange: extraConfig_.lackOfOutgoingTxRange,
      delayLayer2: ITransferEOALegacy(legacyAddress).delayLayer2(),
      delayLayer3: ITransferEOALegacy(legacyAddress).delayLayer3()
    });

    emit TransferEOALegacyCreatedV2(newLegacyId, legacyAddress, msg.sender, distributions_, _legacyExtraConfig, block.timestamp);

    // Premium reminder bootstrap. Wrapped in try/catch so a transient
    // downstream issue never blocks legacy creation — the legacy itself is
    // fully functional without the premium reminder layer.
    try IPremiumSetting(premiumSetting).setPrivateCodeAndCronjob(msg.sender, legacyAddress)
    {} catch {
      emit PrivateCodeSetupNotCompleted(legacyAddress);
    }

    // Layer 2/3 events (nickname field permanently empty — PII-free) so
    // subgraph handlers keep one code path across v1/v2 creates.
    uint256 distribution2 = ITransferEOALegacy(legacyAddress).getDistribution(2, layer2Distribution_.user);
    uint256 distribution3 = ITransferEOALegacy(legacyAddress).getDistribution(3, layer3Distribution_.user);

    if (distribution2 != 0) {
      emit TransferEOALegacyLayer23Created(newLegacyId, 2, layer2Distribution_, "");
    }

    if (distribution3 != 0) {
      emit TransferEOALegacyLayer23Created(newLegacyId, 3, layer3Distribution_, "");
    }
  }

  function avtiveAlive(uint256 legacyId_) external {
    _runActiveAlive(legacyId_, msg.sender);
  }

  /**
   * @dev Gas-sponsored owner check-in. The owner signs an EIP-712 `CheckInAuth`
   * off-chain; any relayer (`msg.sender`) submits it and pays the gas. Identity
   * is the recovered signer, not the sender — the clone's `onlyOwner` check is
   * fed the recovered owner, so only the owner's own timer is reset. Single-shot
   * (sequential per-signer nonce + deadline). See create-flow-v2.md §12a.
   */
  function activeAliveFor(uint256 legacyId_, CheckInAuth calldata auth_) external {
    bytes32 structHash = keccak256(
      abi.encode(CHECKIN_AUTH_TYPEHASH, auth_.owner, legacyId_, auth_.nonce, auth_.deadline)
    );
    _consumeSponsorAuth(auth_.owner, auth_.nonce, auth_.deadline, structHash, auth_.signature);
    _runActiveAlive(legacyId_, auth_.owner);
    emit TransferEOALegacyCheckedInFor(legacyId_, auth_.owner, msg.sender, block.timestamp);
  }

  function _runActiveAlive(uint256 legacyId_, address actor_) internal {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    try 
    IPremiumSetting(premiumSetting).triggerOwnerResetReminder(legacyAddress) 
    {} catch {
      emit EmailOwnerResetNotCompleted(legacyAddress);
    }
    ITransferEOALegacy(legacyAddress).activeAlive(actor_);
    emit TransferEOALegacyActivedAlive(legacyId_, block.timestamp);
  }

  /// @dev v1 ABI kept for pre-v2 frontends; since the PII strip, `name` /
  /// `note` / nickname args are accepted but ignored (metadata API owns them)
  /// and all emitted events carry scrubbed (empty) PII fields.
  function setLegacyConfig(
    uint256 legacyId_,
    LegacyMainConfig calldata mainConfig_,
    TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    string calldata /* nickName2 — ignored */,
    string calldata /* nickName3 — ignored */
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    bool isPremium = IPremiumSetting(premiumSetting).isPremium(msg.sender);

    if (mainConfig_.distributions.length != mainConfig_.nickNames.length || mainConfig_.distributions.length == 0) revert DistributionsInvalid();
    if (extraConfig_.lackOfOutgoingTxRange == 0) revert ActivationTriggerInvalid();

    uint256 numberBeneficiaries = ITransferEOALegacy(legacyAddress).setLegacyDistributions(
      msg.sender,
      mainConfig_.distributions
    );
    if (!_checkNumBeneficiariesLimit(numberBeneficiaries)) revert NumBeneficiariesInvalid();

    // Set activation trigger
    ITransferEOALegacy(legacyAddress).setActivationTrigger(msg.sender, extraConfig_.lackOfOutgoingTxRange);

    // Set delay and layer 2/3 distribution - Now works for both premium and non-premium
    ITransferEOALegacy(legacyAddress).setDelayAndLayer23Distributions(
      msg.sender,
      extraConfig_.delayLayer2,
      extraConfig_.delayLayer3,
      layer2Distribution_,
      layer3Distribution_
    );

    // If the user is not premium, we don't emit events for layer 2/3 distributions
    if (isPremium) {
      // Only emit events for premium users (who can actually update layer 2/3)
      emit TransferEOALegacyLayer23DistributionUpdated(legacyId_, 2, "", layer2Distribution_, block.timestamp);

      emit TransferEOALegacyLayer23DistributionUpdated(legacyId_, 3, "", layer3Distribution_, block.timestamp);
    }

    // Emit final config update with PII fields scrubbed (event shape kept for
    // subgraph compatibility; name/note/nickNames always empty post-v2).
    TransferLegacyStruct.LegacyExtraConfig memory _legacyExtraConfig = TransferLegacyStruct.LegacyExtraConfig({
      lackOfOutgoingTxRange: extraConfig_.lackOfOutgoingTxRange,
      delayLayer2: ITransferEOALegacy(legacyAddress).delayLayer2(),
      delayLayer3: ITransferEOALegacy(legacyAddress).delayLayer3()
    });

    LegacyMainConfig memory scrubbedConfig = LegacyMainConfig({
      name: "",
      note: "",
      nickNames: new string[](0),
      distributions: mainConfig_.distributions
    });

    emit TransferEOALegacyConfigUpdated(legacyId_, scrubbedConfig, _legacyExtraConfig, block.timestamp);
  }

  /// @dev v1 ABI kept; `nickNames_` accepted but ignored since the PII strip.
  function setLegacyDistributions(
    uint256 legacyId_,
    string[] calldata nickNames_,
    TransferLegacyStruct.Distribution[] calldata distributions_
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    if (distributions_.length != nickNames_.length || distributions_.length == 0) revert DistributionsInvalid();
    uint256 numberOfBeneficiaries = ITransferEOALegacy(legacyAddress).setLegacyDistributions(msg.sender, distributions_);
    if (!_checkNumBeneficiariesLimit(numberOfBeneficiaries)) revert NumBeneficiariesInvalid();

    emit TransferEOALegacyDistributionUpdated(legacyId_, new string[](0), distributions_, block.timestamp);
  }

  /// @dev v1 ABI kept; nickname arg accepted but ignored since the PII strip.
  function setLayer23Distributions(
    uint256 legacyId_,
    uint8 layer_,
    string calldata /* nickname_ — ignored */,
    TransferLegacyStruct.Distribution calldata distribution_
  ) external {
    _setLayer23Distributions(legacyId_, layer_, distribution_);
  }


  /// @dev v1 ABI kept; nickname args accepted but ignored since the PII strip.
  function setBothLayer23Distributions(
    uint256 legacyId_,
    string calldata /* nicknameLayer2_ — ignored */,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    string calldata /* nicknameLayer3_ — ignored */,
    TransferLegacyStruct.Distribution calldata layer3Distribution_

  ) external {
    _setLayer23Distributions(legacyId_, 2, layer2Distribution_);
    _setLayer23Distributions(legacyId_, 3, layer3Distribution_);
  }

  function setActivationTrigger(uint256 legacyId_, uint128 lackOfOutgoingTxRange_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    if (lackOfOutgoingTxRange_ == 0) revert ActivationTriggerInvalid();
    ITransferEOALegacy(legacyAddress).setActivationTrigger(msg.sender, lackOfOutgoingTxRange_);
    emit TransferEOALegacyTriggerUpdated(legacyId_, lackOfOutgoingTxRange_, block.timestamp);
  }

  // setNameNote removed in create-flow v2 (§5.1): name/note are PII and now
  // live exclusively in the off-chain metadata API (§7). Storing them on-chain
  // (or echoing them in events) was the PII leak the strip exists to close.

  function activeLegacy(uint256 legacyId_, address[] calldata assets_, bool isETH_) external {
    _runActiveLegacy(legacyId_, assets_, isETH_, msg.sender);
  }

  /**
   * @dev Gas-sponsored beneficiary claim. The beneficiary signs an EIP-712
   * `ClaimAuth` off-chain (binding legacyId + the asset list + isETH + nonce +
   * deadline); any relayer (`msg.sender`) submits it and pays the gas. The
   * recovered signer is used as the claiming beneficiary, so funds are
   * distributed to that beneficiary's own allocation exactly as in the direct
   * `activeLegacy` path — the relayer never receives anything. Permissionless +
   * single-shot. See create-flow-v2.md §12a.
   */
  function activeLegacyFor(
    uint256 legacyId_,
    address[] calldata assets_,
    bool isETH_,
    ClaimAuth calldata auth_
  ) external {
    if (sponsoredClaimsDisabled[legacyId_]) revert SponsoredClaimsDisabled();
    bytes32 structHash = keccak256(
      abi.encode(
        CLAIM_AUTH_TYPEHASH,
        auth_.beneficiary,
        legacyId_,
        keccak256(abi.encodePacked(assets_)),
        isETH_,
        auth_.nonce,
        auth_.deadline
      )
    );
    _consumeSponsorAuth(auth_.beneficiary, auth_.nonce, auth_.deadline, structHash, auth_.signature);
    _runActiveLegacy(legacyId_, assets_, isETH_, auth_.beneficiary);
    emit TransferEOALegacyClaimedFor(legacyId_, auth_.beneficiary, msg.sender, block.timestamp);
  }

  /**
   * @dev Owner opt-out for gas-sponsored claims on their legacy. Sponsored
   * claims are ON by default; an owner who wants to forbid third-party relaying
   * sets `enabled_ == false`, after which `activeLegacyFor` reverts and
   * beneficiaries use the always-available direct `activeLegacy`. Owner-only;
   * does not touch the clone. The choice is fully reversible.
   */
  function setSponsoredClaimsEnabled(uint256 legacyId_, bool enabled_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    if (IPremiumLegacy(legacyAddress).getLegacyOwner() != msg.sender) revert OnlyOwner();
    sponsoredClaimsDisabled[legacyId_] = !enabled_;
    emit SponsoredClaimsConfigured(legacyId_, msg.sender, enabled_);
  }

  function _runActiveLegacy(uint256 legacyId_, address[] calldata assets_, bool isETH_, address actor_) internal {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    if (isETH_ == false && assets_.length == 0) revert NumAssetsInvalid();

    //Active legacy
    ITransferEOALegacy(legacyAddress).activeLegacy(assets_, isETH_, actor_);
    uint8 beneLayer = ITransferEOALegacy(legacyAddress).getBeneficiaryLayer(actor_);
    uint8 currentLayer = ITransferEOALegacy(legacyAddress).getLayer();
    if (beneLayer > currentLayer) revert CannotClaim();
    if (beneLayer == 0) revert OnlyBeneficaries();

    // Phase B end-state: emit the PII-free transfer-activation notify via PremiumSetting
    // (onlyRouter — non-spoofable, replaces the legacy's deleted onlyLegacy path). Best-effort
    // so a premium-layer hiccup never blocks the claim.
    try IPremiumSetting(premiumSetting).notifyActivatedTransfer(legacyAddress, actor_)
    {} catch {
      emit EmailActivatedNotCompleted(legacyAddress);
    }

    // Activation is a one-way state change: the legacy's `_isActive` flips
    // to 2 inside the call above and the contract becomes a tombstone
    // (`deleteLegacy` is blocked from here on). Release the owner's
    // create-flag so they can spin up a new legacy without coordinating
    // with us. Idempotent — repeat calls (multi-tranche claims that
    // re-enter activeLegacy) are no-ops. We read the owner via
    // IPremiumLegacy because GenericLegacy's `getLegacyOwner` is non-virtual
    // and ITransferEOALegacy can't redeclare it without an override clash.
    isCreateLegacy[IPremiumLegacy(legacyAddress).getLegacyOwner()] = false;

    emit TransferEOALegacyActivated(legacyId_, beneLayer, block.timestamp);
  }

  /**
   * @dev Beneficiary claims the legacy; if the owner has an active storage-token swap,
   * it is atomically swapped back to ETH and distributed in the same transaction.
   */
  function activeLegacyAndUnswap(
    uint256 legacyId_,
    address[] calldata assets_,
    uint256 amountOutMin_,
    uint256 deadline_
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    ITransferEOALegacy(legacyAddress).activeLegacyAndUnswap(
      assets_,
      msg.sender,
      amountOutMin_,
      deadline_
    );

    uint8 beneLayer = ITransferEOALegacy(legacyAddress).getBeneficiaryLayer(msg.sender);
    uint8 currentLayer = ITransferEOALegacy(legacyAddress).getLayer();
    if (beneLayer > currentLayer) revert CannotClaim();
    if (beneLayer == 0) revert OnlyBeneficaries();

    // Phase B end-state: PII-free transfer-activation notify (see activeLegacy).
    try IPremiumSetting(premiumSetting).notifyActivatedTransfer(legacyAddress, msg.sender)
    {} catch {
      emit EmailActivatedNotCompleted(legacyAddress);
    }

    // Same one-way-state-change reasoning as activeLegacy — release the
    // owner so they aren't permanently locked out of creating a fresh one.
    isCreateLegacy[IPremiumLegacy(legacyAddress).getLegacyOwner()] = false;

    emit TransferEOALegacyActivatedWithUnswap(legacyId_, beneLayer, block.timestamp);
  }

  function deleteLegacy(uint256 legacyId_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    isCreateLegacy[msg.sender] = false;

    ITransferEOALegacy(legacyAddress).deleteLegacy(msg.sender);
    emit TransferEOALegacyDeleted(legacyId_, block.timestamp);
  }

  /**
   * @dev Self-service flag-release for owners of already-tombstoned legacies.
   *
   * `deleteLegacy` reverts on legacies that have already been activated
   * (the underlying contract's `isActiveLegacy` modifier blocks delete after
   * `_isActive == 2`), which historically left their owners with a stuck
   * `isCreateLegacy[sender] = true` and no path back. This entry point lets
   * the owner clear that flag for any of their legacies that the system
   * itself considers no-longer-live (claimed by a beneficiary, or deleted
   * via `deleteLegacy`).
   *
   * Authorization: caller must be the legacy's recorded owner. The
   * `isLive()` check on the child contract returns false for both the
   * `_isActive == 2` (claimed) and `_isLive == 2` (deleted) terminal
   * states, so this covers every case where `isCreateLegacy[owner]` could
   * have been left dangling.
   *
   * Idempotent and chain-safe: re-entering on a fresh legacy reverts
   * `LegacyStillActive`; re-entering on the same dead legacy is a no-op
   * write that keeps the flag false.
   */
  function releaseCreateFlag(uint256 legacyId_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    if (legacy.getLegacyOwner() != msg.sender) revert OnlyOwner();
    if (legacy.isLive()) revert LegacyStillActive();
    isCreateLegacy[msg.sender] = false;
    emit TransferEOALegacyCreateFlagReleased(legacyId_, msg.sender, block.timestamp);
  }

  function withdraw(uint256 legacyId_, uint256 amount_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    ITransferEOALegacy(legacyAddress).withdraw(msg.sender, amount_);
  }

  /**
   * @dev Forwards ETH + swap config to the individual legacy contract.
   * The individual contract swaps ETH -> storageToken and sends tokens to the owner's wallet.
   */
  function autoSwap(
    uint256 legacyId_,
    TransferLegacyStruct.EOALegacyETHSwap calldata swap_
  ) external payable {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    ITransferEOALegacy(legacyAddress).autoSwap{value: msg.value}(msg.sender, swap_);
    emit TransferEOALegacyAutoSwapped(legacyId_, swap_.storageToken, msg.value, block.timestamp);
  }

  /**
   * @dev Forwards unswap request to the individual legacy contract.
   * Pulls storageToken from owner's wallet, swaps to ETH, sends ETH to owner.
   */
  function unswap(
    uint256 legacyId_,
    uint256 amountIn_,
    uint256 amountOutMin_,
    uint256 deadline_
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    address storageToken = ITransferEOALegacy(legacyAddress).eoaStorageToken();
    ITransferEOALegacy(legacyAddress).unswap(msg.sender, amountIn_, amountOutMin_, deadline_);
    emit TransferEOALegacyUnswapped(legacyId_, storageToken, amountIn_, block.timestamp);
  }

  /**
   * @dev Returns the expected token amount out for a given ETH amount via Uniswap V2.
   */
  function getEthToTokenAmountOut(
    uint256 ethAmount_,
    address outputToken_
  ) external view returns (uint256) {
    address[] memory path = new address[](2);
    path[0] = weth;
    path[1] = outputToken_;
    uint256[] memory amounts = IUniswapV2Router02(uniswapRouter).getAmountsOut(ethAmount_, path);
    return amounts[1];
  }

  /**
   * @dev Returns the expected ETH amount out for a given token amount via Uniswap V2.
   */
  function getTokenToEthAmountOut(
    uint256 tokenAmount_,
    address token_
  ) external view returns (uint256) {
    address[] memory path = new address[](2);
    path[0] = token_;
    path[1] = weth;
    uint256[] memory amounts = IUniswapV2Router02(uniswapRouter).getAmountsOut(tokenAmount_, path);
    return amounts[1];
  }

  /// @dev Nickname no longer forwarded or emitted since the PII strip (§5.1).
  function _setLayer23Distributions(
    uint256 legacyId_,
    uint8 layer_,
    TransferLegacyStruct.Distribution calldata distribution_
  ) internal {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    ITransferEOALegacy(legacyAddress).setLayer23Distributions(msg.sender, layer_, distribution_);
    emit TransferEOALegacyLayer23DistributionUpdated(legacyId_, layer_, "", distribution_, block.timestamp);
  }

  // ─── Sponsored ("…For") EIP-712 plumbing ─────────────────────────────────

  /// @notice EIP-712 domain separator for sponsored intents, scoped to this
  /// router on the current chain. Exposed so clients can build/verify digests.
  function sponsoredDomainSeparator() external view returns (bytes32) {
    return _domainSeparator();
  }

  /**
   * @notice ERC-5267 domain discovery for the sponsored-intent EIP-712 domain.
   * Lets wallets and signing tooling resolve the domain generically instead of
   * hard-coding it. `fields = 0x0f` advertises name, version, chainId and
   * verifyingContract (no salt, no extensions).
   */
  function eip712Domain()
    external
    view
    returns (
      bytes1 fields,
      string memory name,
      string memory version,
      uint256 chainId,
      address verifyingContract,
      bytes32 salt,
      uint256[] memory extensions
    )
  {
    return ("\x0f", "10102 Legacy Sponsored", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
  }

  /**
   * @notice Cancel any not-yet-relayed sponsored authorization by advancing the
   * caller's sequential nonce. A signed `ClaimAuth` / `CheckInAuth` that is
   * still outstanding (deadline not passed, nonce not consumed) becomes
   * permanently unusable, since `_consumeSponsorAuth` requires an exact nonce
   * match. Standard escape hatch for "I signed with a long deadline and changed
   * my mind" — without it a signer could only kill an outstanding intent by
   * racing it with another sponsored action.
   */
  function invalidateSponsorNonce() external {
    uint256 invalidated;
    unchecked {
      invalidated = sponsorNonce[msg.sender]++;
    }
    emit SponsorNonceInvalidated(msg.sender, invalidated);
  }

  function _domainSeparator() internal view returns (bytes32) {
    return keccak256(
      abi.encode(_EIP712_DOMAIN_TYPEHASH, _EIP712_NAME_HASH, _EIP712_VERSION_HASH, block.chainid, address(this))
    );
  }

  function _hashTypedData(bytes32 structHash_) internal view returns (bytes32) {
    return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash_));
  }

  /**
   * @dev Validate + consume a single-shot sponsored authorization: deadline not
   * passed, nonce equals the signer's current sequential nonce, and the EIP-712
   * signature verifies for the asserted signer. Advances the nonce on success
   * so the intent cannot be replayed.
   *
   * Signer support: EOAs verify via `ECDSA.tryRecover` (exact-match against
   * `signer_`; malformed/malleable signatures simply fail the match). Smart-
   * contract wallets (Safe, Argent, 7702-delegated accounts, …) verify via
   * ERC-1271 `isValidSignature` — `SignatureCheckerLite` requires the
   * staticcall to succeed AND return the exact magic value, closing the
   * Zodiac-style bypass (revert data prefixed with the magic value is NOT
   * acceptance). Identity semantics are unchanged either way: `signer_` is the
   * beneficiary/owner the effects accrue to; the relayer never gains anything.
   *
   * NOTE (inherent to ERC-1271): contract signatures are revocable/mutable —
   * the wallet decides validity at verification time, so a wallet that rotates
   * owners can invalidate an outstanding intent (fine: `invalidateSponsorNonce`
   * exists for EOAs precisely to match that power), and a buggy wallet that
   * accepts anything only ever exposes its own allocation to a forced claim.
   */
  function _consumeSponsorAuth(
    address signer_,
    uint256 nonce_,
    uint256 deadline_,
    bytes32 structHash_,
    bytes calldata signature_
  ) internal {
    if (block.timestamp > deadline_) revert SponsorshipExpired();
    if (nonce_ != sponsorNonce[signer_]) revert InvalidSponsorNonce();
    if (!SignatureCheckerLite.isValidSignatureNow(signer_, _hashTypedData(structHash_), signature_)) {
      revert InvalidSponsorSignature();
    }
    unchecked {
      sponsorNonce[signer_] = nonce_ + 1;
    }
  }
}
