import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandResearchProgress } from "../src/components/creation-workspace";

test("research progress renders only the supplied durable stage and evidence count", () => {
  const resolving = renderToStaticMarkup(createElement(BrandResearchProgress, { stage: "resolving", detail: "Checking the supplied domain", sourceCount: 1 }));
  assert.match(resolving, /Finding the right business/u);
  assert.match(resolving, /Checking the supplied domain/u);
  assert.match(resolving, /1 source found/u);
  assert.match(resolving, /aria-busy="true"/u);

  const ready = renderToStaticMarkup(createElement(BrandResearchProgress, { stage: "review_ready", sourceCount: 3 }));
  assert.match(ready, /Your researched plan is ready/u);
  assert.match(ready, /3 sources found/u);
  assert.match(ready, /aria-busy="false"/u);
  assert.doesNotMatch(ready, /Checking the supplied domain/u);
});
