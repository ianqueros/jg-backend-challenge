import { z } from 'zod';
import { INTERNAL_PROVIDER_ID } from './internal-provider.js';

/** Checks for ASCII control characters to reject unprintable injection payloads. */
function hasControlCharacter(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

/** Validates opaque string identifiers without leading/trailing whitespace or control characters. */
export const opaqueIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (val) => {
      // Reject edge whitespace and controls.
      if (val.trim() !== val) {
        return false;
      }
      return !hasControlCharacter(val);
    },
    {
      message:
        'Identifier must not contain leading/trailing whitespace or control characters',
    },
  );

/** Validates external provider identifiers, reserving internal provider prefixes. */
export const externalProviderIdSchema = opaqueIdentifierSchema.refine(
  (val) => val !== INTERNAL_PROVIDER_ID && !val.startsWith('__'),
  { message: 'Internal provider namespace is reserved' },
);
