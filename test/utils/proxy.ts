import { ethers } from "hardhat";

/**
 * Deploy an upgradeable contract behind an ERC1967Proxy.
 * Returns the contract instance attached to the proxy address.
 *
 * @param factoryName - The contract factory name
 * @param initArgs - Arguments for the initialize function
 * @param initMethod - Name of the initializer (default: "initialize")
 * @param signer - Optional signer to deploy with (determines msg.sender for initialize)
 * @param ctorArgs - Implementation constructor arguments (the EOA router takes
 *   the UpgradeTimelock address since the 2026-11 train)
 */
export async function deployProxy(
  factoryName: string,
  initArgs: any[] = [],
  initMethod: string = "initialize",
  signer?: any,
  ctorArgs: any[] = []
) {
  const Factory = signer
    ? await ethers.getContractFactory(factoryName, signer)
    : await ethers.getContractFactory(factoryName);
  const impl = await Factory.deploy(...ctorArgs);

  const initData = Factory.interface.encodeFunctionData(initMethod, initArgs);

  const ProxyFactory = signer
    ? await ethers.getContractFactory("ERC1967Proxy", signer)
    : await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ProxyFactory.deploy(impl.address, initData);

  return Factory.attach(proxy.address);
}
