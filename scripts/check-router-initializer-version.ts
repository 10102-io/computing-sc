import { ethers, deployments, network } from "hardhat";

async function main() {
  const proxy = (await deployments.get("TransferEOALegacyRouter")).address;
  console.log(`Network: ${network.name}`);
  console.log(`Proxy:   ${proxy}`);

  // OpenZeppelin v5 Initializable ERC-7201 namespace for _initialized:
  //   keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
  // The resulting constant per OZ docs:
  const INITIALIZABLE_STORAGE =
    "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
  // Packed: uint64 _initialized + bool _initializing (first 9 bytes of slot)
  const packed = await ethers.provider.getStorageAt(proxy, INITIALIZABLE_STORAGE);
  console.log(`Initializable slot (v5 ERC-7201): ${packed}`);

  // OpenZeppelin v4 / pre-v5 used sequential storage for Initializable (slot 0).
  // But this router declares its own state at slot 0 (_legacyId), so it's v5.

  // Parse: last 2 bytes before the 9-byte window... actually OZ v5 stores
  // { uint64 _initialized; bool _initializing; } — read as a single slot:
  // bytes 0-7: _initialized (little-endian in the slot reading? check)
  // Solidity packs right-aligned, so:
  //   bytes 31-24 = _initialized (uint64)
  //   byte 23 = _initializing (bool)
  const initializedHex = packed.slice(-16); // last 8 bytes = uint64
  const initialized = BigInt("0x" + initializedHex);
  console.log(`_initialized version: ${initialized}`);
  console.log(`initializeV2 has reinitializer(3) → callable only if version < 3`);
  console.log(`Currently callable: ${initialized < 3n}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
