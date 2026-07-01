import { Platform } from 'obsidian';

export type PlatformType = 'desktop' | 'mobile';

export function getPlatformType(): PlatformType {
  return Platform.isDesktop ? 'desktop' : 'mobile';
}

export function isDesktop(): boolean {
  return Platform.isDesktop;
}

export function isMobile(): boolean {
  return Platform.isMobile;
}

export function getPlatformName(): string {
  if (Platform.isDesktop) {
    if (Platform.isMacOS) return 'macOS';
    if (Platform.isWin) return 'Windows';
    if (Platform.isLinux) return 'Linux';
    return 'Desktop';
  }
  if (Platform.isMobile) {
    if (Platform.isAndroidApp) return 'Android';
    if (Platform.isIosApp) return 'iOS';
    return 'Mobile';
  }
  return 'Unknown';
}
