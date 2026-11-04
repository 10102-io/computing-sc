// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPremiumSetting.sol";

contract PremiumRegistry is OwnableUpgradeable, AccessControlUpgradeable {
  using SafeERC20 for IERC20;

  struct PremiumPlan {
    uint256 usdPrice; //x100 (two digits after the decimal point)
    uint256 duration;
    bool isActive; // false if plan is removed - Soft delete
  }

  ERC20 public usdt;
  ERC20 public usdc;

  AggregatorV3Interface public usdtUsdPriceFeed;
  AggregatorV3Interface public usdcUsdPriceFeed;
  AggregatorV3Interface public ethUsdPriceFeed;

  IPremiumSetting public premiumSetting;

  bytes32 public constant DEPOSITOR = keccak256("DEPOSITOR"); // deposit LINK to this contract
  bytes32 public constant OPERATOR = keccak256("OPERATOR");

  PremiumPlan[] public premiumPlans;

  address public payment;

  // ─── 2026-11 train: coupons and referrals (docs/plans/train-2026-11.md) ───
  // APPENDED after `payment` (layout-safe, auto-zero = no coupons, no splits).

  /// @dev An operator-managed price cut. `uses` counts redemptions; `maxUses`
  /// 0 means unlimited, `expiresAt` 0 means no expiry. A coupon may name a
  /// referrer, who is then credited (and paid their share) for every use.
  struct Coupon {
    uint16 discountBps;
    uint64 expiresAt;
    uint32 maxUses;
    uint32 uses;
    bool active;
    address referrer;
  }

  /// @notice Coupons by keccak256 of the code text.
  mapping(bytes32 codeHash => Coupon) public coupons;

  /// @notice Share of each purchase (basis points of 10,000) paid straight to a
  /// registered referrer. 0 = not registered: the purchase is still
  /// attributed in `PlanSubscribedWithCode`, nothing is split.
  mapping(address referrer => uint16) public referrerShareBps;

  uint256 public constant MAX_COUPON_DISCOUNT_BPS = 5_000;
  uint256 public constant MAX_REFERRER_SHARE_BPS = 3_000;
  /// @dev Gas forwarded with a referrer's ETH share; a referrer that reverts
  /// or runs out forfeits the share to `payment`, the purchase still lands.
  uint256 private constant REFERRER_ETH_GAS = 50_000;

  uint256 public constant ORACLE_STALE_LIMIT = 24 * 3600;

  /* EVENTS */
  event PlanUpdated(uint256 plan, uint256 priceUSD, uint256 duration, string name, string description, string feature);
  event PlanSubcribed(address indexed user, uint256 plan, string paymentMethod, uint256 value);
  event PlanRemoved(uint256 plan);
  event PlanPriceDurationUpdated(uint256 plan, uint256 priceUSD, uint256 duration);
  /// @notice Emitted with `PlanSubcribed` by the `subscribeWith*` entry
  /// points. `value` is what the buyer paid in total (after the coupon),
  /// `referrerShare` the part of it that went to `referrer` (0 if unregistered
  /// or the transfer failed). `code` is the coupon text as typed ("" = none).
  event PlanSubscribedWithCode(
    address indexed user,
    uint256 indexed plan,
    string paymentMethod,
    uint256 value,
    string code,
    address indexed referrer,
    uint256 referrerShare
  );
  event CouponSet(bytes32 indexed codeHash, string code, uint16 discountBps, uint64 expiresAt, uint32 maxUses, address referrer, bool active);
  event ReferrerSet(address indexed referrer, uint16 shareBps);

  error InvalidCoupon();
  error CouponDiscountTooHigh();
  error ReferrerShareTooHigh();
  error InsufficientETH();
  error ETHTransferFailed();

  /* MODIFIERS */
  modifier requirePrice(uint256 plan) {
    require(premiumPlans[plan].usdPrice > 0, "Price has not been set yet");
    _;
  }

  modifier requireDuration(uint256 plan) {
    require(premiumPlans[plan].duration > 0, "Duration has not been set yet");
    _;
  }

  modifier requireActive(uint256 plan) {
    require(premiumPlans[plan].isActive, "Plan has been removed");
    _;
  }

  constructor () {
    _disableInitializers();
  }

  function initialize(
    address _usdt,
    address _usdc,
    address _usdtUsdPriceFeed,
    address _usdcUsdPriceFeed,
    address _ethUsdPriceFeed,
    address _premiumSetting,
    address _payment
  ) public initializer {
    __Ownable_init(msg.sender);
    __AccessControl_init();
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(OPERATOR, msg.sender);
    require(_usdt != address(0), "invalid _usdt");
    require(_usdc != address(0), "invalid _usdc");
    require(_usdtUsdPriceFeed != address(0), "invalid _usdtUsdPriceFeed");
    require(_usdcUsdPriceFeed != address(0), "invalid _usdcUsdPriceFeed");
    require(_ethUsdPriceFeed != address(0), "invalid _ethUsdPriceFeed");
    require(_premiumSetting != address(0), "invalid _premiumSetting");
    require(_payment != address(0), "invalid _payment");

    usdt = ERC20(_usdt);
    usdc = ERC20(_usdc);

    usdtUsdPriceFeed = AggregatorV3Interface(_usdtUsdPriceFeed);
    usdcUsdPriceFeed = AggregatorV3Interface(_usdcUsdPriceFeed);
    ethUsdPriceFeed = AggregatorV3Interface(_ethUsdPriceFeed);

    premiumSetting = IPremiumSetting(_premiumSetting);
    payment = _payment;
  }

  /*ADMIN FUNCTION */
  function createPlans(
    uint256[] calldata durations,
    uint256[] calldata prices,
    string[] calldata names,
    string[] calldata descriptions,
    string[] calldata features
  ) external onlyRole(OPERATOR) {
    require(
      prices.length == durations.length &&
        durations.length == names.length &&
        names.length == descriptions.length &&
        descriptions.length == features.length,
      "Length mismatch"
    );

    for (uint256 i = 0; i < prices.length; i++) {
      require(prices[i] > 0, "Price must be > 0");
      require(durations[i] > 0, "Duration must be > 0");
      premiumPlans.push(PremiumPlan(prices[i], durations[i], true));
      emit PlanUpdated(premiumPlans.length - 1, prices[i], durations[i], names[i], descriptions[i], features[i]);
    }
  }

  function updatePlans(
    uint256[] calldata plans,
    uint256[] calldata durations,
    uint256[] calldata prices,
    string[] calldata names,
    string[] calldata descriptions,
    string[] calldata features
  ) external onlyRole(OPERATOR) {
    require(
      plans.length == prices.length &&
        prices.length == durations.length &&
        durations.length == names.length &&
        names.length == descriptions.length &&
        descriptions.length == features.length,
      "Length mismatch"
    );
    for (uint256 i = 0; i < prices.length; i++) {
      _updatePlan(plans[i], durations[i], prices[i]);
      emit PlanUpdated(plans[i], prices[i], durations[i], names[i], descriptions[i], features[i]);
    }
  }

  function updatePlansPriceAndDuration(
    uint256[] calldata plans,
    uint256[] calldata durations,
    uint256[] calldata prices
  ) external onlyRole(OPERATOR) {
    require(plans.length == prices.length && prices.length == durations.length, "Length mismatch");
    for (uint i = 0; i < plans.length; i++) {
      _updatePlan(plans[i], durations[i], prices[i]);
      emit PlanPriceDurationUpdated(plans[i], prices[i], durations[i]);
    }
  }

  function removePlans(uint256[] calldata plans) external onlyRole(OPERATOR) {
    for (uint256 i = 0; i < plans.length; i++) {
      _removePlan(plans[i]);
    }
  }

  ///@notice dev only - to set an account premium
  function subrcribeByAdmin(address user, uint256 plan, string memory method) external onlyRole(OPERATOR) {
    premiumSetting.updatePremiumTime(user, getPlanDuration(plan));
    emit PlanSubcribed(user, plan, method, 0);
  }

  /* USER FUNCTIONS */
  function subcribeWithUSDT(uint256 plan) external {
    //calculate price in usdt
    uint256 usdtAmount = getPlanPriceUSDT(plan);

    //trasfer token — SafeERC20 so non-standard ERC-20s that don't return a
    //bool (mainnet Tether) don't revert the subscription at the decode step.
    IERC20(address(usdt)).safeTransferFrom(msg.sender, payment, usdtAmount);

    //update plan
    premiumSetting.updatePremiumTime(msg.sender, getPlanDuration(plan));

    emit PlanSubcribed(msg.sender, plan, "USDT", usdtAmount);
  }

  function subcribeWithUSDC(uint256 plan) external {
    //calculate price in usdt
    uint256 usdcAmount = getPlanPriceUSDC(plan);

    //trasfer token — SafeERC20 for parity with the USDT path (defensive even
    //though canonical USDC returns a bool).
    IERC20(address(usdc)).safeTransferFrom(msg.sender, payment, usdcAmount);

    //update plan
    premiumSetting.updatePremiumTime(msg.sender, getPlanDuration(plan));
    emit PlanSubcribed(msg.sender, plan, "USDC", usdcAmount);
  }

  function subcribeWithETH(uint256 plan) external payable {
    //calculate price in ETH
    uint256 ethAmount = getPlanPriceETH(plan);
    require(msg.value >= ethAmount, "Insufficient ETH");

    // Refund the difference. Use .call instead of .transfer so smart-contract
    // wallets (Safe, ERC-4337 accounts, multisig users) receiving the refund
    // are not blocked by the 2300-gas stipend that .transfer imposes. The
    // require() ensures the whole subscription reverts if the refund itself
    // cannot land — leaving the caller's funds intact rather than locked in
    // this contract.
    if (msg.value > ethAmount) {
      (bool refundOk, ) = payable(msg.sender).call{value: msg.value - ethAmount}("");
      require(refundOk, "Refund failed");
    }

    //transfer to payment
    (bool success, ) = payment.call{value: ethAmount}("");
    require(success, "Purchase failed");

    emit PlanSubcribed(msg.sender, plan, "ETH", ethAmount);

    //update plan
    premiumSetting.updatePremiumTime(msg.sender, getPlanDuration(plan));
  }

  /* COUPONS AND REFERRALS (2026-11 train) */

  /// @notice Create or update a coupon (operator). Updating keeps its use count.
  /// Codes travel in clear calldata, so a code is public once used: cap it
  /// with `maxUses` / `expiresAt` when it should stay scarce.
  function setCoupon(
    string calldata code,
    uint16 discountBps,
    uint64 expiresAt,
    uint32 maxUses,
    address referrer,
    bool active
  ) external onlyRole(OPERATOR) {
    if (bytes(code).length == 0) revert InvalidCoupon();
    if (discountBps > MAX_COUPON_DISCOUNT_BPS) revert CouponDiscountTooHigh();
    bytes32 codeHash = keccak256(bytes(code));
    Coupon storage c = coupons[codeHash];
    c.discountBps = discountBps;
    c.expiresAt = expiresAt;
    c.maxUses = maxUses;
    c.referrer = referrer;
    c.active = active;
    emit CouponSet(codeHash, code, discountBps, expiresAt, maxUses, referrer, active);
  }

  /// @notice Register a referrer's automatic share, or 0 to stop splitting
  /// (admin: the governance Safe or the deployer). Attribution never needs
  /// registration; only the payment split does.
  function setReferrer(address referrer, uint16 shareBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(referrer != address(0), "invalid referrer");
    if (shareBps > MAX_REFERRER_SHARE_BPS) revert ReferrerShareTooHigh();
    referrerShareBps[referrer] = shareBps;
    emit ReferrerSet(referrer, shareBps);
  }

  /// @notice The discount `code` gives right now: 0 when it is unknown,
  /// inactive, expired or used up (a usable code may also give 0 and only
  /// attribute its referrer; read `coupons` for the full record).
  function couponDiscountBps(string calldata code) external view returns (uint16) {
    Coupon storage c = coupons[keccak256(bytes(code))];
    return _couponUsable(c) ? c.discountBps : 0;
  }

  /// @notice `subcribeWithUSDT` with an optional coupon `code` ("" = none) and
  /// an optional `referrer` (address(0) = none; a coupon's own referrer wins).
  function subscribeWithUSDT(uint256 plan, string calldata code, address referrer) external {
    _subscribeWithToken(IERC20(address(usdt)), getPlanPriceUSDT(plan), plan, code, referrer, "USDT");
  }

  /// @notice `subcribeWithUSDC` with an optional coupon and referrer.
  function subscribeWithUSDC(uint256 plan, string calldata code, address referrer) external {
    _subscribeWithToken(IERC20(address(usdc)), getPlanPriceUSDC(plan), plan, code, referrer, "USDC");
  }

  /// @notice `subcribeWithETH` with an optional coupon and referrer. Excess
  /// ETH is refunded, as in `subcribeWithETH`.
  function subscribeWithETH(uint256 plan, string calldata code, address referrer) external payable {
    (uint256 price, address credited, uint256 share) = _redeem(getPlanPriceETH(plan), code, referrer);
    if (msg.value < price) revert InsufficientETH();
    if (msg.value > price) {
      (bool refunded, ) = payable(msg.sender).call{value: msg.value - price}("");
      if (!refunded) revert ETHTransferFailed();
    }
    if (share > 0) {
      (bool sent, ) = payable(credited).call{value: share, gas: REFERRER_ETH_GAS}("");
      if (!sent) share = 0;
    }
    (bool paid, ) = payment.call{value: price - share}("");
    if (!paid) revert ETHTransferFailed();

    premiumSetting.updatePremiumTime(msg.sender, getPlanDuration(plan));
    _emitSubscribed(plan, "ETH", price, code, credited, share);
  }

  function _subscribeWithToken(
    IERC20 token,
    uint256 basePrice,
    uint256 plan,
    string calldata code,
    address referrer,
    string memory method
  ) private {
    (uint256 price, address credited, uint256 share) = _redeem(basePrice, code, referrer);
    // A referrer the token refuses (blocklisted, say) forfeits the share; the
    // purchase still lands with the whole price paid to `payment`.
    if (share > 0 && !token.trySafeTransferFrom(msg.sender, credited, share)) share = 0;
    token.safeTransferFrom(msg.sender, payment, price - share);

    premiumSetting.updatePremiumTime(msg.sender, getPlanDuration(plan));
    _emitSubscribed(plan, method, price, code, credited, share);
  }

  /// @dev Applies `code` (one use) and resolves who is credited. A code that
  /// is set but not usable reverts: the buyer was shown a discounted price.
  /// Self-referral is attributed but never paid.
  function _redeem(
    uint256 basePrice,
    string calldata code,
    address referrer
  ) private returns (uint256 price, address credited, uint256 share) {
    price = basePrice;
    credited = referrer;
    if (bytes(code).length != 0) {
      Coupon storage c = coupons[keccak256(bytes(code))];
      if (!_couponUsable(c)) revert InvalidCoupon();
      c.uses += 1;
      price = basePrice - (basePrice * c.discountBps) / 10_000;
      if (c.referrer != address(0)) credited = c.referrer;
    }
    if (credited != address(0) && credited != msg.sender) {
      share = (price * referrerShareBps[credited]) / 10_000;
    }
  }

  function _couponUsable(Coupon storage c) private view returns (bool) {
    return c.active && (c.expiresAt == 0 || block.timestamp <= c.expiresAt) && (c.maxUses == 0 || c.uses < c.maxUses);
  }

  function _emitSubscribed(
    uint256 plan,
    string memory method,
    uint256 price,
    string calldata code,
    address credited,
    uint256 share
  ) private {
    emit PlanSubcribed(msg.sender, plan, method, price);
    emit PlanSubscribedWithCode(msg.sender, plan, method, price, code, credited, share);
  }

  /*INTERNAL FUNCTIONS*/
  function _updatePlan(uint256 plan, uint256 duration, uint256 price) internal requireActive(plan) {
    require(price > 0, "Price must be > 0");
    require(duration > 0, "Duration must be > 0");
    require(plan < premiumPlans.length, "Invalid plan");
    PremiumPlan storage _plan = premiumPlans[plan];
    _plan.usdPrice = price;
    _plan.duration = duration;
  }

  function _removePlan(uint256 plan) internal requireActive(plan) {
    premiumPlans[plan].isActive = false;
    emit PlanRemoved(plan);
  }

  /*VIEW FUNCTIONS*/

  function getPlanDuration(uint256 plan) public view requireDuration(plan) requireActive(plan) returns (uint256) {
    return premiumPlans[plan].duration;
  }

  function getPlanPriceUSD(uint256 plan) public view requirePrice(plan) requireActive(plan) returns (uint256) {
    return premiumPlans[plan].usdPrice;
  }

  ///@dev priceUSD * 10**8 to match Chainlink FeedPrice decimals,
  // and then divided by 100 (two digits after the decimal point)
  function getPlanPriceUSDT(uint256 plan) public view requirePrice(plan) requireActive(plan) returns (uint256) {
    return (getPlanPriceUSD(plan) * 10 ** 6 * (10 ** 6)) / getUSDTPrice();
  }

  ///@dev priceUSD * 10**8 to match Chainlink FeedPrice decimals
  // and then divided by 100 (two digits after the decimal point)
  function getPlanPriceUSDC(uint256 plan) public view requirePrice(plan) requireActive(plan) returns (uint256) {
    return (getPlanPriceUSD(plan) * 10 ** 6 * (10 ** 6)) / getUSDCPrice();
  }

  ///@dev  priceUSD * 10**8 to match Chainlink FeedPrice decimals
  // and then divided by 100 (two digits after the decimal point)
  function getPlanPriceETH(uint256 plan) public view requirePrice(plan) requireActive(plan) returns (uint256) {
    return (getPlanPriceUSD(plan) * 10 ** 6 * (10 ** 18)) / getETHPrice();
  }

  function getUSDCPrice() public view returns (uint256) {
    (, int256 answer, , uint256 updatedAt, ) = usdcUsdPriceFeed.latestRoundData();
    _validateRoundData(answer, updatedAt);
    return uint256(answer);
  }

  function getUSDTPrice() public view returns (uint256) {
    (, int256 answer, , uint256 updatedAt, ) = usdtUsdPriceFeed.latestRoundData();
    _validateRoundData(answer, updatedAt);

    return uint256(answer);
  }

  function getETHPrice() public view returns (uint256) {
    (, int256 answer, , uint256 updatedAt, ) = ethUsdPriceFeed.latestRoundData();
    _validateRoundData(answer, updatedAt);

    return uint256(answer);
  }

  function getNextPlanId() public view returns (uint256) {
    return premiumPlans.length;
  }

  function _validateRoundData(int256 answer, uint256 updatedAt) internal view {
    require(answer > 0, "Invalid price");
    require(updatedAt > 0, "Round not complete");
    require(block.timestamp - updatedAt <= ORACLE_STALE_LIMIT, "Price data is stale");
  }
}
