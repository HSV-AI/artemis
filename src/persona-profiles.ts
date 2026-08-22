import { ARTEMIS_PROFILE } from "./personas/artemis.js";
import { WARTERMIS_PROFILE } from "./personas/wartermis.js";

export interface PersonaProfile {
  id: string;
  name: string;
  instructions: string;
}

export const DEFAULT_PERSONA_PROFILE_ID = "artemis";

export const PERSONA_PROFILES = {
  artemis: ARTEMIS_PROFILE,
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
