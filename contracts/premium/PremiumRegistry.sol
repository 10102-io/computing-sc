// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IPremiumSetting.sol";

contract PremiumRegistry is OwnableUpgradeable, AccessControlUpgradeable {
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

  uint256 public constant ORACLE_STALE_LIMIT = 24 * 3600;

  /* EVENTS */
  event PlanUpdated(uint256 plan, uint256 priceUSD, uint256 duration, string name, string description, string feature);
  event PlanSubcribed(address indexed user, uint256 plan, string paymentMethod, uint256 value);
  event PlanRemoved(uint256 plan);
  event PlanPriceDurationUpdated(uint256 plan, uint256 priceUSD, uint256 duration);

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

    //trasfer token
    usdt.transferFrom(msg.sender, payment, usdtAmount);

    //update plan
    premiumSetting.updatePremiumTime(msg.sender, getPlanDuration(plan));

    emit PlanSubcribed(msg.sender, plan, "USDT", usdtAmount);
  }

  function subcribeWithUSDC(uint256 plan) external {
    //calculate price in usdt
    uint256 usdcAmount = getPlanPriceUSDC(plan);

    //trasfer token
    usdc.transferFrom(msg.sender, payment, usdcAmount);

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
