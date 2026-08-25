import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_PROFILE_ID,
  PERSONA_PROFILES,
  resolvePersonaProfile,
  selectPersonaByAuthorName
} from "../src/persona-profiles.js";
import { ARTEMIS_PROFILE } from "../src/personas/artemis.js";
import { GENERIC_PROFILE } from "../src/personas/generic.js";
import { WARTERMIS_PROFILE } from "../src/personas/wartermis.js";

describe("resolvePersonaProfile", () => {
  it("resolves each bundled profile by normalized id", () => {
    expect(resolvePersonaProfile("generic")).toBe(GENERIC_PROFILE);
    expect(resolvePersonaProfile("artemis")).toBe(ARTEMIS_PROFILE);
    expect(resolvePersonaProfile("wartermis")).toBe(WARTERMIS_PROFILE);
    expect(resolvePersonaProfile("ARTEMIS")).toBe(ARTEMIS_PROFILE);
    expect(resolvePersonaProfile("  Wartermis ")).toBe(WARTERMIS_PROFILE);
  });

  it("defaults to the generic profile", () => {
    expect(resolvePersonaProfile()).toBe(GENERIC_PROFILE);
    expect(DEFAULT_PERSONA_PROFILE_ID).toBe("generic");
  });

  it("rejects blank profile ids", () => {
    expect(() => resolvePersonaProfile("")).toThrow("PERSONA_PROFILE must be one of");
    expect(() => resolvePersonaProfile("   ")).toThrow("PERSONA_PROFILE must be one of");
  });

  it("rejects unknown profile ids", () => {
    expect(() => resolvePersonaProfile("unknown")).toThrow();
    expect(() => resolvePersonaProfile("kipp")).toThrow();
  });

  it("exposes the bundled profile registry", () => {
    expect(PERSONA_PROFILES.artemis).toBe(ARTEMIS_PROFILE);
    expect(PERSONA_PROFILES.generic).toBe(GENERIC_PROFILE);
    expect(PERSONA_PROFILES.wartermis).toBe(WARTERMIS_PROFILE);
  });
});

describe("selectPersonaByAuthorName", () => {
  it("selects the Artemis persona when the name starts with the artemis prefix", () => {
    expect(selectPersonaByAuthorName("Artemis", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
    expect(selectPersonaByAuthorName("Artemis Rose", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
    expect(selectPersonaByAuthorName("artemis", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
    expect(selectPersonaByAuthorName("ARTEMIS", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
    expect(selectPersonaByAuthorName("ArTeMiS Botsworth", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(selectPersonaByAuthorName("  Artemis  ", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
    expect(selectPersonaByAuthorName("\tartemis\n", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
  });

  it("falls back to the default profile for non-matching names", () => {
    expect(selectPersonaByAuthorName("Wartemis", GENERIC_PROFILE)).toBe(GENERIC_PROFILE);
    expect(selectPersonaByAuthorName("Matt", GENERIC_PROFILE)).toBe(GENERIC_PROFILE);
    expect(selectPersonaByAuthorName("xArtemis", GENERIC_PROFILE)).toBe(GENERIC_PROFILE);
    expect(selectPersonaByAuthorName("the artemis", GENERIC_PROFILE)).toBe(GENERIC_PROFILE);
  });

  it("falls back to the default profile for empty or blank names", () => {
    expect(selectPersonaByAuthorName("", GENERIC_PROFILE)).toBe(GENERIC_PROFILE);
    expect(selectPersonaByAuthorName("   ", GENERIC_PROFILE)).toBe(GENERIC_PROFILE);
    expect(selectPersonaByAuthorName(undefined, GENERIC_PROFILE)).toBe(GENERIC_PROFILE);
  });

  it("returns the configured default profile when it is already Artemis and the name does not match", () => {
    expect(selectPersonaByAuthorName("Matt", ARTEMIS_PROFILE)).toBe(ARTEMIS_PROFILE);
    expect(selectPersonaByAuthorName("Wartemis", ARTEMIS_PROFILE)).toBe(ARTEMIS_PROFILE);
  });

  it("returns the configured default profile when it is Wartermis and the name does not match", () => {
    expect(selectPersonaByAuthorName("Matt", WARTERMIS_PROFILE)).toBe(WARTERMIS_PROFILE);
    expect(selectPersonaByAuthorName("Wartemis", WARTERMIS_PROFILE)).toBe(WARTERMIS_PROFILE);
  });

  it("matches a name that is exactly artemis plus a single trailing character", () => {
    expect(selectPersonaByAuthorName("ArtemisX", GENERIC_PROFILE)).toBe(ARTEMIS_PROFILE);
  });
});