import type { Viewer } from "./credits";
import { lockWallet, requireEntitlement } from "./credits";
import { transaction } from "./db";
import { requireCondition } from "./errors";
import { readPublication, writePublication } from "./publications";
import { readBrand, updateBrandRuleInTransaction } from "./brand";

export async function confirmPreference(viewer: Viewer, publicationId: string, input: { proposalId: string; scope: "durable" | "local"; version: number; brandVersion: number; commandKey: string }) {
  return transaction(async (client) => {
    await requireEntitlement(client, await lockWallet(client, viewer.id));
    const state = await readPublication(viewer.id, publicationId, client, true);
    const completed = state.creation?.status === "ready" || state.outlineApproved || Boolean(state.preparation?.closed);
    requireCondition(state.version === input.version && !state.pendingOperation,
      "preference_changed", "Refresh the current draft. Preferences cannot overwrite queued or approved work.", 409);
    const selected = state.preferenceProposals?.find((item) => item.id === input.proposalId);
    requireCondition(selected, "preference_unavailable", "That preference suggestion is no longer available.", 404);
    const message = state.messages.find((item) => item.id === selected.messageId && item.role === "user");
    requireCondition(message?.text.includes(selected.evidence), "preference_unavailable", "The original user evidence is unavailable.", 409);
    requireCondition(!completed || input.scope === "durable", "preference_scope", "A completed post can only save a preference for future posts.", 409);
    requireCondition(selected.scope !== "local" || input.scope === "local", "preference_scope", "A post-local request cannot become a standing rule without a new explicit request.", 409);
    let brand = await readBrand(viewer.id, client);
    requireCondition(brand.version === input.brandVersion, "brand_changed", "The brand changed. Review its latest rules before confirming this preference.", 409);
    if (input.scope === "durable") brand = await updateBrandRuleInTransaction(client, viewer, { field: selected.field, value: selected.value, version: input.brandVersion, commandKey: input.commandKey });
    else state.localPreferences = { ...state.localPreferences, [selected.field]: selected.value };
    state.preferenceProposals = state.preferenceProposals!.filter((item) => item.id !== selected.id);
    if (!completed) state.status = "collecting";
    state.messages.push({ id: crypto.randomUUID(), role: "user", text: `Confirmed ${input.scope === "durable" ? "standing" : "post-local"} preference: ${selected.field} = ${selected.value}.${completed ? " Apply it to future posts without changing this finished post." : " Apply it to the next preparation reply."}`, createdAt: new Date().toISOString() });
    return { publication: await writePublication(client, state, completed ? "Standing preference confirmed; finished post preserved" : `${input.scope === "durable" ? "Standing" : "Post-local"} preference confirmed; new copy approval required`), brand };
  });
}
