// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
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
 * 2. Per-beneficiary backup lines. With `backupDelay` set, every first-line
 *    share is claimed by its own line, A then A2 then A3: A from the
 *    activation deadline, A2 from `backupDelay` later, A3 from twice that,
 *    first to claim each token's share takes it. The whole-estate second and
 *    third lines work exactly as before.
 * 3. An executor. An address that can never be a beneficiary, a backup or the
 *    owner may attest the owner's death, which brings the activation deadline
 *    forward to `DEATH_GRACE` after the attestation; any owner activity in
 *    the meantime (a check-in, any owner action) cancels it. Never needed for
 *    a claim, never holds or receives anything.
 *
 * The v3 settings are called on this legacy by the owner directly (no router
 * change); check-ins and claims still go through the router. Storage is
 * appended after TransferEOALegacy's (slot 26 on).
 */
contract TransferEOALegacyV3 is TransferEOALegacy, ReentrancyGuardTransient {
  using EnumerableSet for EnumerableSet.AddressSet;

  /// @notice The collection allowlist, fixed in this implementation's code.
  address public immutable nftAllowlist;

  uint256 public constant DEATH_GRACE = 30 days;
  uint256 public constant MIN_BACKUP_DELAY = 30 days;
  uint256 public constant MAX_BACKUP_DELAY = 3650 days;
  uint256 public constant MAX_NFT_ITEMS = 50;

  struct BackupLine {
    address primary;
    address second;
    address third;
  }

  struct NftItem {
    address collection;
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
  /// @dev Per token (address(0) = ETH), bit i set = first-line share i took
  /// its part of the current round. A full mask starts a new round.
  mapping(address token => uint256) internal _claimedMask;
  mapping(uint256 epoch => NftItem[]) internal _nftItems;
  mapping(uint256 epoch => mapping(uint256 index => bool)) internal _nftClaimed;

  error NotExecutor();
  error ExecutorInvalid();
  error AttestationNotAllowed();
  error BackupDelayInvalid();
  error BackupLineInvalid();
  error BackupNotYet(uint256 opensAt);
  error NftsDisabled();
  error NftItemInvalid(uint256 index);
  error TooManyNftItems();

  event ExecutorSet(address indexed executor);
  event DeathAttested(address indexed executor, uint256 deadline);
  /// @notice Lines replaced (or voided, with backupDelay 0); one BackupLineSet per line precedes it.
  event BackupLinesSet(uint256 indexed epoch, uint64 backupDelay);
  event BackupLineSet(uint256 indexed epoch, address indexed primary, address second, address third);
  /// @notice Items replaced (or voided, with count 0); one NftItemSet per item precedes it.
  event NftItemsSet(uint256 indexed epoch, uint256 count);
  event NftItemSet(uint256 indexed epoch, uint256 index, address indexed collection, uint256 tokenId, uint256 amount, address indexed beneficiary);
  event ShareClaimed(address indexed token, address indexed claimant, address indexed primary, uint256 amount);
  event NftClaimed(uint256 indexed index, address indexed collection, uint256 tokenId, uint256 amount, address indexed to);

  modifier onlyOwnerCaller() {
    if (msg.sender != getLegacyOwner()) revert OnlyOwner();
    _;
  }

  constructor(address nftAllowlist_) {
    nftAllowlist = nftAllowlist_;
  }

  // ─── Executor ─────────────────────────────────────────────────────────────

  /// @notice Name (or, with address(0), remove) the executor. Clears any
  /// pending attestation and counts as owner activity.
  function setExecutor(address executor_) external onlyOwnerCaller onlyLive isActiveLegacy {
    if (executor_ != address(0) && (executor_ == getLegacyOwner() || _isOnAnyLine(executor_))) revert ExecutorInvalid();
    executor = executor_;
    deathAttestedAt = 0;
    _lastTimestamp = block.timestamp;
    emit ExecutorSet(executor_);
  }

  /// @notice The executor attests the owner's death: claims open
  /// `DEATH_GRACE` from now unless the owner shows activity first. At most
  /// one attestation per grace period.
  function attestDeath() external {
    if (msg.sender != executor || executor == address(0)) revert NotExecutor();
    if (!isLive() || _checkActiveLegacy() || _isOnAnyLine(msg.sender)) revert AttestationNotAllowed();
    if (deathAttestedAt != 0 && block.timestamp < uint256(deathAttestedAt) + DEATH_GRACE) revert AttestationNotAllowed();
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

  /// @notice Turn per-share mode on with these lines (premium), or off with
  /// `backupDelay_ == 0` and no lines. Replaces any previous lines.
  function setBackupLines(uint64 backupDelay_, BackupLine[] calldata lines_) external onlyOwnerCaller onlyLive isActiveLegacy {
    uint256 epoch = ++_linesEpoch;
    if (backupDelay_ == 0) {
      if (lines_.length != 0) revert BackupDelayInvalid();
    } else {
      if (backupDelay_ < MIN_BACKUP_DELAY || backupDelay_ > MAX_BACKUP_DELAY) revert BackupDelayInvalid();
      if (!premiumSetting.isPremium(msg.sender)) revert NotPremium();
      address owner_ = getLegacyOwner();
      for (uint256 i; i < lines_.length; ++i) {
        BackupLine calldata line = lines_[i];
        if (_distributions[line.primary] == 0 || _lines[epoch][line.primary][0] != address(0)) revert BackupLineInvalid();
        if (line.second == address(0) || line.second == line.third) revert BackupLineInvalid();
        _claimBackupSlot(epoch, line.primary, line.second, owner_);
        if (line.third != address(0)) _claimBackupSlot(epoch, line.primary, line.third, owner_);
        _lines[epoch][line.primary] = [line.second, line.third];
        emit BackupLineSet(epoch, line.primary, line.second, line.third);
      }
    }
    backupDelay = backupDelay_;
    _lastTimestamp = block.timestamp;
    emit BackupLinesSet(epoch, backupDelay_);
  }

  function _claimBackupSlot(uint256 epoch, address primary, address backup, address owner_) private {
    if (
      backup == owner_ ||
      backup == executor ||
      TransferEOALegacy.getBeneficiaryLayer(backup) != 0 ||
      _primaryOf[epoch][backup] != address(0)
    ) revert BackupLineInvalid();
    _primaryOf[epoch][backup] = primary;
  }

  /// @notice A first-line share's backups (A2, A3) under the current lines.
  function getBackupLine(address primary) external view returns (address second, address third) {
    address[2] storage line = _lines[_linesEpoch][primary];
    return (line[0], line[1]);
  }

  /// @notice The first-line beneficiary whose share `backup` stands behind.
  function primaryOf(address backup) external view returns (address) {
    return _primaryOf[_linesEpoch][backup];
  }

  /// @notice Bitmask of first-line shares (index in getLegacyBeneficiaries)
  /// that took their part of `token`'s current round (address(0) = ETH).
  function claimedMask(address token) external view returns (uint256) {
    return _claimedMask[token];
  }

  /// @dev Backups count as first-line claimants for the router's checks.
  function getBeneficiaryLayer(address beneficiary) public view override returns (uint8) {
    uint8 layer = TransferEOALegacy.getBeneficiaryLayer(beneficiary);
    if (layer == 0 && backupDelay != 0 && _primaryOf[_linesEpoch][beneficiary] != address(0)) return 1;
    return layer;
  }

  /// @dev A beneficiary change voids backup lines and NFT items when the
  /// first line changed (they name first-line addresses), and must never
  /// make the executor a beneficiary.
  function _afterBeneficiariesChanged(bool layer1Changed_) internal override {
    if (executor != address(0) && TransferEOALegacy.getBeneficiaryLayer(executor) != 0) revert ExecutorInvalid();
    if (layer1Changed_) {
      uint256 epoch = ++_linesEpoch;
      backupDelay = 0;
      emit BackupLinesSet(epoch, 0);
      epoch = ++_nftEpoch;
      emit NftItemsSet(epoch, 0);
    }
  }

  function _isOnAnyLine(address who) private view returns (bool) {
    return TransferEOALegacy.getBeneficiaryLayer(who) != 0 || _primaryOf[_linesEpoch][who] != address(0);
  }

  // ─── Per-share claims ─────────────────────────────────────────────────────

  function _transferAssetToBeneficiaries(address[] calldata assets_, bool isETH_, address bene_) internal override {
    if (backupDelay == 0 || getBeneficiaryLayer(bene_) != 1) {
      super._transferAssetToBeneficiaries(assets_, isETH_, bene_);
      return;
    }
    address primary = _distributions[bene_] > 0 ? bene_ : _primaryOf[_linesEpoch][bene_];
    uint256 rank = primary == bene_ ? 0 : (_lines[_linesEpoch][primary][0] == bene_ ? 1 : 2);
    uint256 opensAt = _activationDeadline() + rank * uint256(backupDelay);
    if (block.timestamp < opensAt) revert BackupNotYet(opensAt);

    address[] memory shares = _beneficiariesSet.values();
    uint256 bit;
    for (uint256 i; i < shares.length; ++i) {
      if (shares[i] == primary) bit = 1 << i;
    }
    uint256 full = (1 << shares.length) - 1;
    uint256 pct = _distributions[primary];

    if (isETH_) {
      uint256 mask = _roundMask(address(0), full);
      if (mask & bit == 0) {
        uint256 amount = (address(this).balance * pct) / _unclaimedPercent(shares, mask);
        uint256 fee = (amount * adminFeePercent) / 10000;
        if (amount > 0 && _transferEthToBeneficiary(bene_, amount - fee) > 0) {
          _claimedMask[address(0)] = mask | bit;
          if (fee > 0) _transferEthToBeneficiary(paymentContract, fee);
          emit ShareClaimed(address(0), bene_, primary, amount - fee);
        }
      }
    }

    address ownerAddress = getLegacyOwner();
    uint256 n = assets_.length < MAX_TRANSFER ? assets_.length : MAX_TRANSFER;
    for (uint256 t; t < n; ++t) {
      address token = assets_[t];
      if (token == eoaStorageToken) eoaStorageToken = address(0);
      uint256 mask = _roundMask(token, full);
      if (mask & bit != 0) continue;
      (PullRoute route, uint256 allowance_, address vault) = _route(ownerAddress, token);
      uint256 balance = IERC20(token).balanceOf(ownerAddress);
      uint256 amount = ((balance < allowance_ ? balance : allowance_) * pct) / _unclaimedPercent(shares, mask);
      if (amount == 0) continue;
      uint256 fee = (amount * adminFeePercent) / 10000;
      uint256 sent = _transferErc20ToBeneficiary(token, ownerAddress, bene_, amount - fee, route, vault);
      if (sent == 0) continue;
      _claimedMask[token] = mask | bit;
      if (fee > 0) {
        uint256 before = IERC20(token).balanceOf(address(this));
        _transferErc20ToBeneficiary(token, ownerAddress, address(this), fee, route, vault);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received > 0) _swapAdminFee(token, received);
      }
      emit ShareClaimed(token, bene_, primary, sent);
    }
  }

  function _roundMask(address token, uint256 full) private view returns (uint256 mask) {
    mask = _claimedMask[token];
    if (mask == full) mask = 0;
  }

  function _unclaimedPercent(address[] memory shares, uint256 mask) private view returns (uint256 total) {
    for (uint256 i; i < shares.length; ++i) {
      if (mask & (1 << i) == 0) total += _distributions[shares[i]];
    }
  }

  // ─── NFTs ─────────────────────────────────────────────────────────────────

  /// @notice Replace the NFT items this legacy hands on. Each names an
  /// allowed collection and a first-line beneficiary; ERC-721 amount is 1.
  function setNftItems(NftItem[] calldata items_) external onlyOwnerCaller onlyLive isActiveLegacy {
    if (nftAllowlist == address(0)) revert NftsDisabled();
    if (items_.length > MAX_NFT_ITEMS) revert TooManyNftItems();
    uint256 epoch = ++_nftEpoch;
    NftItem[] storage list = _nftItems[epoch];
    for (uint256 i; i < items_.length; ++i) {
      NftItem calldata item = items_[i];
      uint8 kind = INftCollectionWhiteList(nftAllowlist).kindOf(item.collection);
      bool amountOk = kind == 1 ? item.amount == 1 : (kind == 2 && item.amount > 0);
      if (!amountOk || _distributions[item.beneficiary] == 0) revert NftItemInvalid(i);
      list.push(item);
      emit NftItemSet(epoch, i, item.collection, item.tokenId, item.amount, item.beneficiary);
    }
    _lastTimestamp = block.timestamp;
    emit NftItemsSet(epoch, items_.length);
  }

  function nftItemCount() external view returns (uint256) {
    return _nftItems[_nftEpoch].length;
  }

  function nftItem(uint256 index) external view returns (NftItem memory item, bool claimed) {
    uint256 epoch = _nftEpoch;
    return (_nftItems[epoch][index], _nftClaimed[epoch][index]);
  }

  /**
   * @notice Claim NFT items once the legacy is claimable. A second- or
   * third-line beneficiary (in its period) takes every item; on the first line
   * each item goes to its named beneficiary, or in per-share mode to whoever
   * of that beneficiary's line claims it in their window. Items the caller may
   * not take yet, or that fail to move, are skipped. Called by the claimant
   * directly, not through the router.
   */
  function claimNfts(uint256[] calldata indexes_) external nonReentrant returns (uint256 moved) {
    if (!(_checkActiveLegacy() && _isLive == 1)) revert NotEnoughContitionalActive();
    uint8 layer = getBeneficiaryLayer(msg.sender);
    if (layer == 0 || layer > getCurrentLayer()) revert NotBeneficiary();
    if (getIsActiveLegacy() == 1) _setLegacyToInactive();

    uint256 epoch = _nftEpoch;
    NftItem[] storage list = _nftItems[epoch];
    for (uint256 k; k < indexes_.length; ++k) {
      uint256 index = indexes_[k];
      if (index >= list.length || _nftClaimed[epoch][index]) continue;
      NftItem memory item = list[index];
      address to = _nftPayee(item.beneficiary, layer);
      if (to == address(0)) continue;
      _nftClaimed[epoch][index] = true;
      uint256 amount = _pullNft(item, to);
      if (amount == 0) {
        _nftClaimed[epoch][index] = false;
        continue;
      }
      ++moved;
      emit NftClaimed(index, item.collection, item.tokenId, amount, to);
    }
  }

  function _nftPayee(address primary, uint8 layer) private view returns (address) {
    if (layer != 1) return msg.sender;
    if (backupDelay == 0) return primary;
    uint256 rank;
    if (msg.sender == primary) rank = 0;
    else if (_primaryOf[_linesEpoch][msg.sender] == primary) rank = _lines[_linesEpoch][primary][0] == msg.sender ? 1 : 2;
    else return address(0);
    return block.timestamp >= _activationDeadline() + rank * uint256(backupDelay) ? msg.sender : address(0);
  }

  /// @dev Through the bound vault when the owner approved it as operator,
  /// otherwise straight from the owner's approval to this legacy. Returns the
  /// amount moved (0 = nothing moved).
  function _pullNft(NftItem memory item, address to) private returns (uint256 amount) {
    address owner_ = getLegacyOwner();
    address vault = pullVault;
    // `isApprovedForAll` has the same selector on ERC-721 and ERC-1155.
    bool viaVault = vault != address(0) &&
      ILegacyPullVault(vault).boundLegacy(owner_) == address(this) &&
      _staticBool(item.collection, abi.encodeCall(IERC721.isApprovedForAll, (owner_, vault)));
    // The allowlist is not read here: a collection removed after it was named
    // stays claimable.
    bytes memory data;
    if (_staticBool(item.collection, abi.encodeCall(IERC165.supportsInterface, (0x80ac58cd)))) {
      amount = 1;
      data = viaVault
        ? abi.encodeCall(ILegacyPullVaultNft.pullERC721, (owner_, item.collection, to, item.tokenId))
        : abi.encodeCall(IERC721SafeTransfer.safeTransferFrom, (owner_, to, item.tokenId));
    } else {
      (bool ok, bytes memory ret) = item.collection.staticcall(abi.encodeCall(IERC1155.balanceOf, (owner_, item.tokenId)));
      if (!ok || ret.length < 32) return 0;
      uint256 balance = abi.decode(ret, (uint256));
      amount = balance < item.amount ? balance : item.amount;
      if (amount == 0) return 0;
      data = viaVault
        ? abi.encodeCall(ILegacyPullVaultNft.pullERC1155, (owner_, item.collection, to, item.tokenId, amount))
        : abi.encodeCall(IERC1155.safeTransferFrom, (owner_, to, item.tokenId, amount, ""));
    }
    (bool sent, ) = (viaVault ? vault : item.collection).call(data);
    if (!sent) return 0;
  }

  function _staticBool(address target, bytes memory data) private view returns (bool) {
    (bool ok, bytes memory ret) = target.staticcall(data);
    return ok && ret.length >= 32 && abi.decode(ret, (uint256)) == 1;
  }
}
