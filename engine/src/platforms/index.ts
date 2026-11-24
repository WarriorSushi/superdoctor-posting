import type { Platform, PlatformId } from './base';
import { facebook } from './facebook';
import { instagram } from './instagram';
import { linkedin } from './linkedin';
import { youtube } from './youtube';

export const platforms: Record<PlatformId, Platform> = { instagram, facebook, youtube, linkedin };
