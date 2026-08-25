import { ARTEMIS_PROFILE } from "./personas/artemis.js";
import { GENERIC_PROFILE } from "./personas/generic.js";
import { WARTERMIS_PROFILE } from "./personas/wartermis.js";

export interface PersonaProfile {
  id: string;
  name: string;
  instructions: string;
}

/**
 * The default persona profile. The generic profile defines no fixed identity
 * name, so the bot's display name is resolved from the connected Discord
 * client at startup and used for self-introduction. Selecting a named profile
 * (`artemis`, `wartermis`) overrides that behavior with the profile's own name.
 */
export const DEFAULT_PERSONA_PROFILE_ID = "generic";

/**
 * Sensible fallback display name used when the selected persona does not
 * define a name (the generic profile) and the Discord client has not yet
 * reported a display name. Keeps the bot's self-introduction well-formed.
 */
export const DEFAULT_BOT_DISPLAY_NAME = "Artemis";

export const PERSONA_PROFILES = {
  artemis: ARTEMIS_PROFILE,
  generic: GENERIC_PROFILE,
  wartermis: WARTERMIS_PROFILE
} as const satisfies Record<string, PersonaProfile>;

export function resolvePersonaProfile(id = DEFAULT_PERSONA_PROFILE_ID): PersonaProfile {
  const normalizedId = id.trim().toLowerCase();
  const profile = PERSONA_PROFILES[normalizedId as keyof typeof PERSONA_PROFILES];
  if (!profile) {
    throw new Error(
      `Invalid configuration: PERSONA_PROFILE must be one of ${Object.keys(PERSONA_PROFILES).join(", ")}`
    );
  }
  return profile;
}

/**
 * The leading prefix that selects the Artemis persona from an author display
 * name. Matching is case-insensitive and anchored to the start of the trimmed
 * name, so a name like `Wartemis` does not match.
 */
export const ARTEMIS_NAME_PREFIX = "artemis";

/**
 * Select the persona profile to apply for an incoming Discord message based on
 * the author's display name. When the trimmed name starts with the
 * case-insensitive prefix {@link ARTEMIS_NAME_PREFIX} (`artemis`), the bundled
 * Artemis profile is selected. Otherwise the supplied `defaultProfile` (the
 * deployment-configured persona) is returned unchanged. The match is anchored
 * to the start of the name: `Artemis`, `Artemis Rose`, and `artemis` match,
 * while `Wartemis` and `xArtemis` do not. Empty, blank, or missing names never
 * match and fall back to the default profile.
 */
export function selectPersonaByAuthorName(
  authorName: string | undefined,
  defaultProfile: PersonaProfile
): PersonaProfile {
  const trimmed = authorName?.trim() ?? "";
  if (trimmed.toLowerCase().startsWith(ARTEMIS_NAME_PREFIX)) {
    return ARTEMIS_PROFILE;
  }
  return defaultProfile;
}