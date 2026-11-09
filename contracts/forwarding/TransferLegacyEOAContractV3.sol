// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TransferEOALegacy} from "./TransferLegacyEOAContract.sol";
import {ILegacyPullVault} from "../interfaces/ILegacyPullVault.sol";

interface INftCollectionWhiteList {
  function kindOf(address collection) external view returns (uint8);
}

/// @dev The three-argument ERC-721 transfer (IERC721 overloads the name).
interface IERC721SafeTransfer {
  function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface ILegacyPullVaultNft {
  function pullERC721(address owner_, address collection_, address to_, uint256 tokenId_) external;

  function pullERC1155(address owner_, address collection_, address to_, uint256 id_, uint256 amount_) external;
}

/**
 * @title TransferEOALegacyV3
 * @notice EOA legacy clone implementation, version 3 (docs/plans/
 * train-2026-11.md, wave B). Everything TransferEOALegacy does, unchanged and
 * inherited, plus three optional features, all off by default:
 *
 * 1. NFTs. The owner names ERC-721 / ERC-1155 items from collections on the
 *    NftCollectionWhiteList (checked when named, never at claim) and the
 *    first-line beneficiary each goes to. Items stay in the owner's wallet;
 *    at claim they move through LegacyPullVaultV2 (the owner approves that one
 *    verified operator) or a direct approval to this legacy.
 * 2. Per-beneficiary backup lines (Premium). With `backupDelay` set, every
 *    first-line share is its own running account per token, claimed by its
 *    own line: A from the activation deadline, A2 from `backupDelay` later,
 *    A3 from twice that. Each claim pays the share's due, its percentage of
 *    everything that share's token ever made available minus what the share
 *    already received, so no claim takes from another share and nobody waits
 *    for another heir. The second and third lines, in their periods, take
 *    only the shares whose own line never claimed; a share its line claimed
 *    stays that line's, later inflows included.
 * 3. An executor (Premium). An address that can never be a beneficiary, a
 *    backup or the owner may attest the owner's death once the owner has been
 *    silent for half the activation trigger; claims then open `DEATH_GRACE`
 *    after the attestation unless the owner shows any activity first. Never
 *    needed for a claim, never holds or receives anything.
 *
 * The v3 settings are called on this legacy by the owner directly (no router
 * change); check-ins and token claims still go through the router. Storage is
 * appended after TransferEOALegacy's (slot 26 on).
 */
contract TransferEOALegacyV3 is TransferEOALegacy, ReentrancyGuardTransient {
  using EnumerableSet for EnumerableSet.AddressSet;

  /// @notice The collection allowlist, fixed in this implementation's code.
  address public immutable nftAllowlist;

  // Fixed in code and documented (docs/plans/train-2026-11.md, wave B); not
  // exposed as getters, for size.
  uint256 internal constant DEATH_GRACE = 30 days;
  uint256 internal constant MIN_BACKUP_DELAY = 30 days;
  uint256 internal constant MAX_BACKUP_DELAY = 3650 days;
  uint256 internal constant MAX_NFT_ITEMS = 50;

  struct BackupLine {
    address primary;
    address second;
    address third;
  }

  /// @dev `kind` 1 = ERC-721 (amount 1), 2 = ERC-1155; it must match the
  /// allowlist when named and is what the claim uses.
  struct NftItem {
    address collection;
    uint8 kind;
    uint256 tokenId;
    uint256 amount;
    address beneficiary;
  }

  // ─── Appended storage (slot 26 on; clones of v3 only) ────────────────────
  /// @notice 0 = no executor.
  address public executor;
  /// @notice When the executor last attested; active while after the owner's
  /// last activity (`getLastTimestamp`).
  uint64 public deathAttestedAt;
  /// @notice 0 = per-share mode off (one claim pays every first-line share).
  uint64 public backupDelay;
  /// @dev Bumped whenever backup lines are replaced or the first line changes,
  /// voiding the previous lines in O(1).
  uint64 internal _linesEpoch;
  /// @dev Same for NFT items.
  uint64 internal _nftEpoch;
  mapping(uint256 epoch => mapping(address primary => address[2])) internal _lines;
  mapping(uint256 epoch => mapping(address backup => address)) internal _primaryOf;
  /// @notice Per-share mode: everything released to first-line shares, per
  /// token (address(0) = ETH), and what each share (keyed by its first-line
  /// beneficiary) received, gross of the claim fee.
  mapping(address token => uint256) public totalReleased;
  mapping(address token => mapping(address primary => uint256)) public released;
  mapping(uint256 epoch => NftItem[]) internal _nftItems;
  /// @dev Units of each item already moved (ERC-1155 may move in parts).
  mapping(uint256 epoch => mapping(uint256 index => uint256)) internal _nftMoved;
  /// @notice Per-share mode: the first address that received anything from
  /// the share (tokens, ETH or an NFT unit), on whatever line. From then on
  /// only that address receives from the share. 0 = nobody yet.
  mapping(address primary => address) public shareOwner;

  error NotExecutor();
  error ExecutorInvalid();
  error AttestationNotAllowed();
  error BackupDelayInvalid();
  error BackupLineInvalid();
  error BackupNotYet(uint256 opensAt);
  error UnswapNotInPerShareMode();
  error NftsDisabled();
  error NftItemInvalid(uint256 index);
  error TooManyNftItems();
  error ShareOwned(address owner);
  error FirstLineInvalid();
  error NothingClaimed();

  event ExecutorSet(address indexed executor);
  event DeathAttested(address indexed executor, uint256 deadline);
  /// @notice Lines replaced, or voided (backupDelay 0); one BackupLineSet per line precedes it.
  event BackupLinesSet(uint256 indexed epoch, uint64 backupDelay);
  event BackupLineSet(uint256 indexed epoch, address indexed primary, address second, address third);
  /// @notice Items replaced, or voided (count 0); one NftItemSet per item precedes it.
  event NftItemsSet(uint256 indexed epoch, uint256 count);
  event NftItemSet(uint256 indexed epoch, uint256 index, address indexed collection, uint8 kind, uint256 tokenId, uint256 amount, address indexed beneficiary);
  /// @notice A per-share claim: `primary` is the share (address(0) = every
  /// share, a second- or third-line claim), `amount` is gross of the fee.
  event ShareClaimed(address indexed token, address indexed claimant, address indexed primary, uint256 amount);
  event NftClaimed(uint256 indexed index, address indexed collection, uint256 tokenId, uint256 amount, address indexed to);
  /// @notice The legacy activated through an NFT claim, which does not pass
  /// through the router; same meaning as the router's
  /// `TransferEOALegacyActivated`.
  event LegacyActivated(uint256 indexed legacyId, uint8 layer, uint256 timestamp);

  constructor(address nftAllowlist_) {
    nftAllowlist = nftAllowlist_;
  }

  /// @dev Owner-only v3 setting while the legacy is live and not activated;
  /// counts as owner activity (and so cancels a pending attestation).
  function _ownerSetting() private {
    if (msg.sender != getLegacyOwner()) revert OnlyOwner();
    if (!isLive()) revert LegacyIsDeleted();
    _lastTimestamp = block.timestamp;
  }

  function _requirePremium() private view {
    if (!premiumSetting.isPremium(msg.sender)) revert NotPremium();
  }

  // ─── Executor ─────────────────────────────────────────────────────────────

  /// @notice Name (Premium) or, with address(0), remove the executor. Clears
  /// any pending attestation.
  function setExecutor(address executor_) external {
    _ownerSetting();
    if (executor_ != address(0)) {
      if (executor_ == msg.sender || _isOnAnyLine(executor_)) revert ExecutorInvalid();
      _requirePremium();
    }
    executor = executor_;
    deathAttestedAt = 0;
    emit ExecutorSet(executor_);
  }

  /// @notice The executor attests the owner's death: claims open
  /// `DEATH_GRACE` from now unless the owner shows activity first. Only after
  /// the owner has been silent for half the activation trigger, and at most
  /// once per grace period.
  function attestDeath() external {
    if (msg.sender != executor) revert NotExecutor();
    if (
      !isLive() ||
      _checkActiveLegacy() ||
      _isOnAnyLine(msg.sender) ||
      block.timestamp < _lastTimestamp + getActivationTrigger() / 2 ||
      (deathAttestedAt != 0 && block.timestamp < uint256(deathAttestedAt) + DEATH_GRACE)
    ) revert AttestationNotAllowed();
    deathAttestedAt = uint64(block.timestamp);
    emit DeathAttested(msg.sender, _activationDeadline());
  }

  /// @dev The normal deadline, or `DEATH_GRACE` after an attestation the owner
  /// has not answered with any activity, whichever is sooner.
  function _activationDeadline() internal view override returns (uint256) {
    uint256 deadline = super._activationDeadline();
    if (deathAttestedAt > _lastTimestamp) {
      uint256 shortened = uint256(deathAttestedAt) + DEATH_GRACE;
      if (shortened < deadline) return shortened;
    }
    return deadline;
  }

  // ─── Backup lines ─────────────────────────────────────────────────────────

  /// @notice Turn per-share mode on with these lines (Premium), or off with
  /// `backupDelay_ == 0` and no lines. Replaces any previous lines. The second
  /// line, if any, must open at least two backup delays after the deadline,
  /// so every backup's window opens before it.
  function setBackupLines(uint64 backupDelay_, BackupLine[] calldata lines_) external {
    _ownerSetting();
    uint256 epoch = ++_linesEpoch;
    if (backupDelay_ == 0) {
      if (lines_.length != 0) revert BackupDelayInvalid();
    } else {
      if (backupDelay_ < MIN_BACKUP_DELAY || backupDelay_ > MAX_BACKUP_DELAY) revert BackupDelayInvalid();
      _requirePremium();
      for (uint256 i; i < lines_.length; ++i) {
        BackupLine calldata line = lines_[i];
        if (_distributions[line.primary] == 0 || _lines[epoch][line.primary][0] != address(0)) revert BackupLineInvalid();
        if (line.second == address(0) || line.second == line.third) revert BackupLineInvalid();
        _claimBackupSlot(epoch, line.primary, line.second);
        if (line.third != address(0)) _claimBackupSlot(epoch, line.primary, line.third);
        _lines[epoch][line.primary] = [line.second, line.third];
        emit BackupLineSet(epoch, line.primary, line.second, line.third);
      }
    }
    backupDelay = backupDelay_;
    _checkConfig(true);
    emit BackupLinesSet(epoch, backupDelay_);
  }

  function _claimBackupSlot(uint256 epoch, address primary, address backup) private {
    if (
      backup == msg.sender ||
      backup == executor ||
      TransferEOALegacy.getBeneficiaryLayer(backup) != 0 ||
      _primaryOf[epoch][backup] != address(0)
    ) revert BackupLineInvalid();
    _primaryOf[epoch][backup] = primary;
  }

  /// @dev Per-share mode only (whole-estate claims pay every first-line
  /// share, so nothing below can strand anything there). Backups open before
  /// the second line sweeps (review L-4), and no first-line primary is the
  /// second- or third-line beneficiary: such an address counts as first line
  /// and could never sweep. With `full` (entering or changing per-share mode)
  /// the first line must also sum to 100%: one created with a repeated
  /// address keeps its last percentage only. A first-line edit leaves
  /// per-share mode, so after one nothing is checked; this is also what lets
  /// the router's combined setters pass through transient states.
  function _checkConfig(bool full) private view {
    if (backupDelay == 0) return;
    if (delayLayer2 != 0 && delayLayer2 < 2 * uint256(backupDelay)) revert BackupDelayInvalid();
    uint256 sum = _distributions[_layer2Beneficiary] + _distributions[_layer3Beneficiary];
    if (sum != 0) revert FirstLineInvalid();
    if (!full) return;
    address[] memory shares = _beneficiariesSet.values();
    for (uint256 i; i < shares.length; ++i) sum += _distributions[shares[i]];
    if (sum != MAX_PERCENT) revert FirstLineInvalid();
  }

  /// @notice A first-line share's backups (A2, A3) under the current lines.
  function getBackupLine(address primary) external view returns (address second, address third) {
    address[2] storage line = _lines[_linesEpoch][primary];
    return (line[0], line[1]);
  }

  /// @dev Backups count as first-line claimants for the router's checks.
  function getBeneficiaryLayer(address beneficiary) public view override returns (uint8) {
    uint8 layer = TransferEOALegacy.getBeneficiaryLayer(beneficiary);
    if (layer == 0 && _primaryOf[_linesEpoch][beneficiary] != address(0)) return 1;
    return layer;
  }

  /// @dev After any beneficiary or delay change: the executor and the backups
  /// stay off every other line (review L-3), a first-line change voids the
  /// backup lines (per-share mode off) and the NFT items, with their events
  /// (they name first-line addresses; the owner sets them again), and a
  /// legacy still in per-share mode passes `_checkConfig`.
  function _afterBeneficiariesChanged(bool layer1Changed_) internal override {
    uint256 epoch = _linesEpoch;
    if (
      (executor != address(0) && TransferEOALegacy.getBeneficiaryLayer(executor) != 0) ||
      _primaryOf[epoch][_layer2Beneficiary] != address(0) ||
      _primaryOf[epoch][_layer3Beneficiary] != address(0)
    ) revert BackupLineInvalid();
    if (layer1Changed_) {
      epoch = ++_linesEpoch;
      backupDelay = 0;
      emit BackupLinesSet(epoch, 0);
      epoch = ++_nftEpoch;
      emit NftItemsSet(epoch, 0);
    }
    _checkConfig(false);
  }

  function _isOnAnyLine(address who) private view returns (bool) {
    return TransferEOALegacy.getBeneficiaryLayer(who) != 0 || _primaryOf[_linesEpoch][who] != address(0);
  }

  /// @dev In per-share mode the unswap claim would convert every share's token
  /// at the caller's minimum; heirs claim the token (or ETH) instead.
  function _checkUnswapClaim() internal view override {
    if (backupDelay != 0) revert UnswapNotInPerShareMode();
  }

  // ─── Per-share claims ─────────────────────────────────────────────────────

  /// @dev Under this legacy's own guard, shared with `claimNfts`: no token
  /// claim runs inside another or inside an NFT move, whatever the router.
  function _transferAssetToBeneficiaries(address[] calldata assets_, bool isETH_, address bene_) internal override nonReentrant {
    if (backupDelay == 0) {
      super._transferAssetToBeneficiaries(assets_, isETH_, bene_);
      return;
    }
    // A first-line claimant settles their own share once their window opens,
    // if nobody else owns it yet; a second- or third-line claimant (the
    // router checked the period) settles every share nobody else owns
    // (`only == address(0)`). Ownership is recorded where value moves.
    address only;
    if (getBeneficiaryLayer(bene_) == 1) {
      only = _distributions[bene_] > 0 ? bene_ : _primaryOf[_linesEpoch][bene_];
      uint256 opensAt = _activationDeadline() + _rank(only, bene_) * uint256(backupDelay);
      if (block.timestamp < opensAt) revert BackupNotYet(opensAt);
      address owner_ = shareOwner[only];
      if (owner_ != address(0) && owner_ != bene_) revert ShareOwned(owner_);
    }
    address[] memory shares = _beneficiariesSet.values();
    address ownerAddress = getLegacyOwner();
    if (isETH_) _settle(address(0), address(this).balance, shares, only, bene_, PullRoute.DirectErc20, address(0));
    uint256 n = assets_.length < MAX_TRANSFER ? assets_.length : MAX_TRANSFER;
    for (uint256 t; t < n; ++t) {
      address token = assets_[t];
      if (token == eoaStorageToken) eoaStorageToken = address(0);
      (PullRoute route, uint256 allowance_, address vault) = _route(ownerAddress, token);
      uint256 balance = IERC20(token).balanceOf(ownerAddress);
      _settle(token, balance < allowance_ ? balance : allowance_, shares, only, bene_, route, vault);
    }
  }

  /**
   * @dev Pays `to` the due of one share (`only`) or of every share, for one
   * token. A share's due is its percentage of everything the token ever made
   * available to the first line (`available` now plus `totalReleased`) minus
   * what it already received, so claim order and inflows between claims
   * change nothing for anyone else. A failed payout records nothing.
   */
  function _settle(
    address token,
    uint256 available,
    address[] memory shares,
    address only,
    address to,
    PullRoute route,
    address vault
  ) private {
    if (available == 0) return;
    uint256 pot = available + totalReleased[token];
    uint256 amount = _dues(token, pot, shares, only, to, available, false);
    if (amount == 0) return;
    uint256 fee = (amount * adminFeePercent) / 10000;
    if (_pay(token, to, amount - fee, route, vault) == 0) return;
    _dues(token, pot, shares, only, to, available, true);
    totalReleased[token] += amount;
    // The fee goes to Payment as it is (ETH as ETH, a token from the owner's
    // wallet on the payout's rail). A failed fee is not collected, never
    // reverts the claim and is not owed: it stays in the pot (K-13).
    if (fee > 0) _pay(token, paymentContract, fee, route, vault);
    emit ShareClaimed(token, to, only, amount);
  }

  /// @dev ETH from this legacy, a token from the owner's wallet; 0 on failure.
  function _pay(address token, address to, uint256 amount, PullRoute route, address vault) private returns (uint256) {
    return token == address(0)
      ? _transferEthToBeneficiary(to, amount)
      : _transferErc20ToBeneficiary(token, getLegacyOwner(), to, amount, route, vault);
  }

  /// @dev Sum of the dues in scope (one share, or every share owned by nobody
  /// or by `to`) at `pot`, filled in share order up to `cap` (what is
  /// pullable now); with `record_` (after the payout), adds each to what its
  /// share received and makes `to` the owner of each share it paid. The dues
  /// fit under the cap unless the owner's wallet shrank since an earlier
  /// claim; then a share gets what is there and the rest stays owed.
  function _dues(
    address token,
    uint256 pot,
    address[] memory shares,
    address only,
    address to,
    uint256 cap,
    bool record_
  ) private returns (uint256 amount) {
    for (uint256 i; i < shares.length; ++i) {
      address share = shares[i];
      address owner_ = shareOwner[share];
      if (only != address(0) ? share != only : owner_ != address(0) && owner_ != to) continue;
      uint256 entitled = (pot * _distributions[share]) / MAX_PERCENT;
      uint256 got = released[token][share];
      if (entitled <= got) continue;
      uint256 due = entitled - got;
      if (due > cap - amount) due = cap - amount;
      if (due == 0) continue;
      amount += due;
      if (record_) {
        released[token][share] = got + due;
        shareOwner[share] = to;
      }
    }
  }

  /// @dev 0 for the primary, 1 for A2, 2 for A3.
  function _rank(address primary, address claimant) private view returns (uint256) {
    if (claimant == primary) return 0;
    return _lines[_linesEpoch][primary][0] == claimant ? 1 : 2;
  }

  // ─── NFTs ─────────────────────────────────────────────────────────────────

  /// @notice Replace the NFT items this legacy hands on. Each names an
  /// allowed collection with its kind and a first-line beneficiary; ERC-721
  /// amount is 1.
  function setNftItems(NftItem[] calldata items_) external {
    _ownerSetting();
    if (nftAllowlist == address(0)) revert NftsDisabled();
    if (items_.length > MAX_NFT_ITEMS) revert TooManyNftItems();
    uint256 epoch = ++_nftEpoch;
    NftItem[] storage list = _nftItems[epoch];
    for (uint256 i; i < items_.length; ++i) {
      NftItem calldata item = items_[i];
      uint8 kind = INftCollectionWhiteList(nftAllowlist).kindOf(item.collection);
      if (
        kind == 0 ||
        item.kind != kind ||
        (kind == 1 ? item.amount != 1 : item.amount == 0) ||
        _distributions[item.beneficiary] == 0
      ) revert NftItemInvalid(i);
      list.push(item);
      emit NftItemSet(epoch, i, item.collection, kind, item.tokenId, item.amount, item.beneficiary);
    }
    emit NftItemsSet(epoch, items_.length);
  }

  /// @return item the item; @return moved the units already claimed.
  function nftItem(uint256 index) external view returns (NftItem memory item, uint256 moved) {
    uint256 epoch = _nftEpoch;
    return (_nftItems[epoch][index], _nftMoved[epoch][index]);
  }

  /**
   * @notice Claim NFT items once the legacy is claimable. A second- or
   * third-line beneficiary (in its period) takes every item, in per-share
   * mode only those of shares nobody else owns; on the first line each item
   * goes to its named beneficiary, or in per-share mode to whoever of that
   * beneficiary's line claims it in their window while nobody else owns the
   * share. A unit that moves makes its recipient the share's owner. Items the caller may
   * not take yet, or that fail to move, are skipped; an ERC-1155 item can move
   * in parts. The legacy activates only when something moves. Called by the
   * claimant directly, not through the router.
   */
  function claimNfts(uint256[] calldata indexes_) external nonReentrant returns (uint256 moved) {
    if (!(_checkActiveLegacy() && _isLive == 1)) revert NotEnoughContitionalActive();
    uint8 layer = getBeneficiaryLayer(msg.sender);
    if (layer == 0 || layer > getCurrentLayer()) revert NotBeneficiary();
    // Claimed before any external call, so no transfer callback finds the
    // legacy live (an owner contract could delete or edit it mid-claim). If
    // nothing moves the call reverts, so the legacy is not activated (review L-2).
    bool activates = getIsActiveLegacy() == 1;
    if (activates) _setLegacyToInactive();

    uint256 epoch = _nftEpoch;
    NftItem[] storage list = _nftItems[epoch];
    for (uint256 k; k < indexes_.length; ++k) {
      uint256 index = indexes_[k];
      if (index >= list.length) continue;
      NftItem memory item = list[index];
      uint256 left = item.amount - _nftMoved[epoch][index];
      address to = _nftPayee(item.beneficiary, layer);
      if (left == 0 || to == address(0)) continue;
      _nftMoved[epoch][index] += left;
      uint256 amount = _pullNft(item, left, to);
      if (amount < left) _nftMoved[epoch][index] -= left - amount;
      if (amount == 0) continue;
      ++moved;
      if (backupDelay != 0) shareOwner[item.beneficiary] = to;
      if (activates && moved == 1) emit LegacyActivated(getLegacyId(), layer, block.timestamp);
      emit NftClaimed(index, item.collection, item.tokenId, amount, to);
    }
    if (activates && moved == 0) revert NothingClaimed();
  }

  function _nftPayee(address primary, uint8 layer) private view returns (address) {
    if (backupDelay == 0) return layer == 1 ? primary : msg.sender;
    address owner_ = shareOwner[primary];
    if (owner_ != address(0) && owner_ != msg.sender) return address(0);
    if (layer != 1) return msg.sender;
    if (msg.sender != primary && _primaryOf[_linesEpoch][msg.sender] != primary) return address(0);
    return block.timestamp >= _activationDeadline() + _rank(primary, msg.sender) * uint256(backupDelay) ? msg.sender : address(0);
  }

  /// @dev Up to `left` units, through the pinned vault (it moves them only for
  /// the bound legacy, and only if the owner approved it as operator), else
  /// straight from the owner's approval to this legacy. Returns the units
  /// moved (0 = nothing moved). The allowlist is not read: a collection
  /// removed after it was named stays claimable.
  function _pullNft(NftItem memory item, uint256 left, address to) private returns (uint256 amount) {
    address owner_ = getLegacyOwner();
    address collection = item.collection;
    if (collection.code.length == 0) return 0;
    bytes memory viaVault;
    bytes memory direct;
    if (item.kind == 1) {
      amount = 1;
      viaVault = abi.encodeCall(ILegacyPullVaultNft.pullERC721, (owner_, collection, to, item.tokenId));
      direct = abi.encodeCall(IERC721SafeTransfer.safeTransferFrom, (owner_, to, item.tokenId));
    } else {
      (bool ok, bytes memory ret) = collection.staticcall(abi.encodeCall(IERC1155.balanceOf, (owner_, item.tokenId)));
      if (!ok || ret.length < 32) return 0;
      amount = abi.decode(ret, (uint256));
      if (amount > left) amount = left;
      if (amount == 0) return 0;
      viaVault = abi.encodeCall(ILegacyPullVaultNft.pullERC1155, (owner_, collection, to, item.tokenId, amount));
      direct = abi.encodeCall(IERC1155.safeTransferFrom, (owner_, to, item.tokenId, amount, ""));
    }
    address vault = pullVault;
    if (vault != address(0)) {
      (bool vaultMoved, ) = vault.call(viaVault);
      if (vaultMoved) return amount;
    }
    (bool moved, ) = collection.call(direct);
    if (!moved) return 0;
  }
}
