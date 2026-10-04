// Single-file `.aio` packages (Node only): store-mode ZIP64, optional WinZip AES-256.
export {
  exportPackage,
  openPackage,
  scanProject,
  volumeFreeBytes,
  type ExportPackageOptions,
  type OpenedPackage,
  type OpenPackageResult,
} from './package';
export { planPackage, type LayerShare, type PackagePlanResult, type SourceFile } from './plan';
export { openZip, ZipError, type ZipArchive, type ZipEntry } from './reader';
export { writeZip, type WriteZipOptions, type ZipMember, type ZipProgress } from './writer';
