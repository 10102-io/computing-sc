async function main() {
  const { ethers, network } = require("hardhat");
  await network.provider.request({ method: "hardhat_impersonateAccount", params: ["0x974763b760d566154B1767534cF9537CEe2f886f"] });
  await network.provider.send("hardhat_setBalance", ["0x974763b760d566154B1767534cF9537CEe2f886f", "0x1000000000000000000"]);
  const dev = await ethers.getSigner("0x974763b760d566154B1767534cF9537CEe2f886f");
  try {
    const sig = await dev.signMessage("test");
    console.log("signMessage succeeded, sig:", sig.substring(0, 20) + "...");
  } catch (e) {
    console.log("signMessage failed:", e.message.substring(0, 200));
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
