// Constructor args for PremiumRegistry proxy on Sepolia.
// Extracted from creation tx 0x4efafe593dc9791a402c834e399ba9f663bf90f9c36e045787c5257d5fba8f6e.
// Contract is ERC1967Proxy(address logic, bytes data).
module.exports = [
  // logic = PremiumRegistry implementation
  "0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b",
  // data = initialize(usdt, usdc, usdtUsdPriceFeed, usdcUsdPriceFeed,
  //                   ethUsdPriceFeed, premiumSetting, payment)
  "0x3587647600000000000000000000000002f62735eaf5ffb56b629bc529e72801713f27cd0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238000000000000000000000000a2f78ab2355fe2f984d808b5cee7fd0a93d5270e000000000000000000000000a2f78ab2355fe2f984d808b5cee7fd0a93d5270e000000000000000000000000694aa1769357215de4fac081bf1f309adc325306000000000000000000000000ea267a1f6d554dd416d26c60efef9234ebfde95e000000000000000000000000d4bf99da7fbcb0a2fd80754cb5cc9c7cdc9e8d78",
];
