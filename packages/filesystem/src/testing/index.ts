/**
 * `@jsails/filesystem/testing`: the `Disk` conformance suite. It registers
 * `node:test` tests, so it lives apart from the runtime entry.
 */

export {
  runDiskContract,
  type DiskContractFactory,
  type DiskContractFaults,
  type DiskContractOptions,
  type DiskContractSubject,
} from './disk-contract.js';
