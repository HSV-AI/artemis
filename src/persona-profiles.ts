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