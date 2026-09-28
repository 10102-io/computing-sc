/**
 * Live rehearsal of ShieldVault on the current network (Sepolia):
 *   register a veto commitment -> open a position with a fallback ->
 *   request a withdrawal (the "thief" move) -> veto to the committed
 *   recovery wallet -> assert the position closed and the funds moved.
 * Timed exits (withdraw after the delay, fallback after silence) need days
 * of wall-clock time and are covered by test/ShieldVault.spec.ts.
 *
 *   npx hardhat run scripts/smoke-shield-vault.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";

/** Public RPCs sometimes under-estimate cold storage writes by a few
 * thousand gas; every write here carries a 25% margin. */
async function withMargin(est: Promise<any>) {
  return { gasLimit: (await est).mul(125).div(100) };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const book = getContracts()[network.name] as any;
  const vault = await ethers.getContractAt("ShieldVault", book.ShieldVault.address);
  const registry = await ethers.getContractAt("QuantumRecoveryRegistry", book.QuantumRecoveryRegistry.address);
  const token = await ethers.getContractAt("LegacyToken", book.ERC20Token_R2USD.address);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`Network ${network.name}, vault ${vault.address}, owner key ${deployer.address}`);

  const amount = ethers.utils.parseUnits("5", await token.decimals());
  if ((await token.balanceOf(deployer.address)).lt(amount)) await (await token.mint(deployer.address, amount.mul(20))).wait();
  if ((await token.allowance(deployer.address, vault.address)).lt(amount)) {
    await (await token.approve(vault.address, ethers.constants.MaxUint256)).wait();
  }

  const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
  const recoveryTo = ethers.Wallet.createRandom().address;
  const digest = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "uint256", "address", "bytes32", "address"],
      [ethers.utils.id("10102.ShieldVault.veto.v1"), chainId, vault.address, secret, recoveryTo]
    )
  );
  const index = await registry.commitmentCount(deployer.address);
  await (await registry.register(digest, 5, vault.address)).wait();
  console.log(`commitment #${index} registered for recovery wallet ${recoveryTo}`);

  const heir = ethers.Wallet.createRandom().address;
  const config = { exitDelay: 7 * 86400, silencePeriod: 180 * 86400, beneficiaries: [heir], sharesBps: [10000] };
  const openTx = await vault.open(token.address, amount, config, index, await withMargin(vault.estimateGas.open(token.address, amount, config, index)));
  await openTx.wait();
  const id = await vault.positionCount();
  console.log(`position ${id} opened, tx ${openTx.hash}`);

  const req = await vault.requestWithdraw(id, amount, deployer.address, await withMargin(vault.estimateGas.requestWithdraw(id, amount, deployer.address)));
  await req.wait();
  const p1 = await vault.positionOf(id);
  console.log(`withdrawal requested, ready at ${new Date(p1.pending.readyAt.toNumber() * 1000).toISOString()}`);
  try {
    await vault.callStatic.executePending(id);
    throw new Error("executePending succeeded before the delay");
  } catch (e: any) {
    if (/succeeded before/.test(e.message)) throw e;
    console.log("early execution refused, as expected");
  }

  const vetoTx = await vault.veto(id, secret, recoveryTo, await withMargin(vault.estimateGas.veto(id, secret, recoveryTo)));
  await vetoTx.wait();
  const p2 = await vault.positionOf(id);
  const moved = await token.balanceOf(recoveryTo);
  if (!p2.closed || !p2.balance.isZero()) throw new Error("position not closed by the veto");
  if (!moved.eq(amount)) throw new Error(`recovery wallet holds ${moved}, expected ${amount}`);
  console.log(`veto tx ${vetoTx.hash}: ${ethers.utils.formatUnits(moved, await token.decimals())} moved to the recovery wallet`);
  console.log("\n=== SHIELD VAULT SMOKE PASSED ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
