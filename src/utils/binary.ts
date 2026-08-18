/**
 * Binary file detection utilities
 */

/**
 * Binary file extensions that should not be decoded as UTF-8
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tiff', 'tif',
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma',
  // Video
  'mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
  // Other binary
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite',
]);

/**
 * Check if a file is binary based on its extension
 */
export function isBinaryFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXTENSIONS.has(ext);
}
