import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreativePlan } from "../src/shared/creative-intent";
import { semanticTones, visualGrammars, type SemanticDirectionV1 } from "../src/shared/semantic-direction";
import { createDesignSceneV2, validateDesignScene } from "../src/server/design-scene";
import { missingDiscountTerms } from "../src/server/publications";
import { semanticArtDirection, validateSemanticDirection } from "../src/server/semantic-direction";

const base: SemanticDirectionV1 = { policy: "semantic-direction-v1", palette: { background: "#FFF8F1", foreground: "#2F241F", accent: "#C85A3A", muted: "#E9D6C8" }, headingFont: "serif", spacing: "open", tone: "warm", grammar: "soft-organic", rationale: "A warm direction for an approachable local story." };

test("semantic direction normalizes, projects without originals and rejects unsafe provider choices", () => {
  const valid = validateSemanticDirection({ mode: "propose", tone: base.tone, grammar: base.grammar, background: "#fff8f1", foreground: "#2f241f", accent: "#c85a3a", muted: "#e9d6c8", headingFont: "serif", spacing: "open", rationale: ` ${base.rationale} ` }, "propose")!;
  assert.equal(valid.palette.background, "#FFF8F1");
  assert.deepEqual(semanticArtDirection(valid).direction, { policy: "art-direction-v1", palette: valid.palette, headingFont: "serif", composition: "editorial", spacing: "open", logoMaterialId: null, heroMaterialIds: [] });
  assert.doesNotThrow(() => validateSemanticDirection({ mode: "propose", tone: "energetic", grammar: "bold-geometry", background: "#FFFFFF", foreground: "#111111", accent: "#FF6B00", muted: "#DADADA", headingFont: "sans", spacing: "compact", rationale: "A bright accent remains distinct from the dark primary surface." }, "propose"));
  const guarded = validateSemanticDirection({ mode: "propose", tone: "calm", grammar: "soft-organic", background: "#FFFFFF", foreground: "#111111", accent: "#F8F8F8", muted: "#FEFEFE", headingFont: "serif", spacing: "open", rationale: "A restrained palette whose decorative roles need local contrast correction." }, "propose")!;
  assert.equal(guarded.palette.accent, "#F8F8F8");
  assert.notEqual(guarded.palette.muted, "#FEFEFE");
  assert.throws(() => validateSemanticDirection({ mode: "propose", tone: "loud", grammar: base.grammar, background: "#FFFFFF", foreground: "#000000", accent: "#777777", muted: "#EEEEEE", headingFont: "sans", spacing: "open", rationale: "No." }, "propose"));
  assert.throws(() => validateSemanticDirection({ mode: "propose", tone: base.tone, grammar: base.grammar, background: "#FFFFFF", foreground: "#EEEEEE", accent: "#FFFFFF", muted: "#FFFFFF", headingFont: "Comic Sans", spacing: "open", rationale: "No." }, "propose"));
  assert.throws(() => validateSemanticDirection({ mode: "propose", tone: base.tone, grammar: base.grammar, background: "#FFFFFF", foreground: "#000000", accent: "#777777", muted: "#EEEEEE", headingFont: "sans", spacing: "open", rationale: "x", materialId: "bad" }, "propose"));
  assert.throws(() => validateSemanticDirection({ mode: "inherit", tone: "warm", grammar: "soft-organic", background: "#FFFFFF", foreground: "#000000", accent: "#777777", muted: "#EEEEEE", headingFont: "sans", spacing: "open", rationale: "smuggled" }, "inherit"));
});

test("all bounded semantic scenes are deterministic and grammar-distinct", () => {
  const purposes = ["hook", "explain", "proof", "process", "closing"] as const;
  const geometries = new Set<string>();
  for (const grammar of visualGrammars) for (const tone of semanticTones) for (const purpose of purposes) {
    const direction = { ...base, grammar, tone };
    const art = semanticArtDirection(direction);
    const plan: CreativePlan = { purpose, recipe: purpose === "closing" ? "closing" : "type-poster", materialId: "", heading: "large", background: purpose === "closing" ? "foreground" : "background", alignment: purpose === "closing" ? "center" : "left", rationale: "Bounded semantic scene." };
    const scene = createDesignSceneV2(plan, art, "accepted-quote", 0, direction);
    assert.deepEqual(createDesignSceneV2(plan, art, "accepted-quote", 0, direction), scene);
    assert.equal(validateDesignScene(scene, plan, art).version, 2);
    if (tone === "precise" && purpose === "hook") geometries.add(JSON.stringify(scene.primitives));
  }
  assert.ok(geometries.size >= 3);
});

test("discount blockers respect explicit negation but require terms for a positive offer", () => {
  for (const idea of ["A post with no discounts", "Ein Post ohne Rabatte", "Пост без скидок"]) assert.equal(missingDiscountTerms(idea), false);
  for (const idea of ["Announce our discount", "Unser Rabatt diese Woche", "Расскажи про скидку"]) assert.equal(missingDiscountTerms(idea), true);
  assert.equal(missingDiscountTerms("Announce our 15% discount"), false);
});
