import type { Viewer } from "./credits";
import { lockWallet, requireEntitlement } from "./credits";
import { transaction } from "./db";
import { requireCondition } from "./errors";
import { readPublication, writePublication } from "./publications";
import { readBrand, updateBrandRuleInTransaction } from "./brand";
import type { PoolClient } from "pg";
import type { PublicationView } from "../shared/contracts";

export async function autoSaveDurableRevisionPreferences(
  client: PoolClient,
  ownerId: string,
  operationId: string,
  revisionMessageId: string,
  revisionInstruction: string,
  expectedBrandVersion: number,
  state: PublicationView,
) {
  const proposals = state.preferenceProposals ?? [];
  if (state.status !== "ready" || state.creation?.status !== "ready") return;
  const durable = proposals.filter((proposal) => proposal.scope === "durable" && proposal.messageId === revisionMessageId && proposal.evidence === revisionInstruction);
  const duplicateFields = new Set(durable.filter((proposal, index) => durable.some((other, otherIndex) => otherIndex !== index && other.field === proposal.field)).map((proposal) => proposal.field));
  const eligible = durable.filter((proposal) => {
    const evidence = state.messages.find((message) => message.id === proposal.messageId && message.role === "user");
    return !duplicateFields.has(proposal.field) && evidence?.text === revisionInstruction;
  });
  if (!eligible.length) return;

  let brand = await readBrand(ownerId, client);
  if (brand.version !== expectedBrandVersion) return;
  const saved = [];
  const viewer = { id: ownerId, name: "", email: "" };
  for (const proposal of eligible) {
    const commandKey = `auto-preference:${operationId}:${proposal.id}`;
    if (brand.rules[proposal.field] === proposal.value) {
      state.preferenceProposals = state.preferenceProposals?.filter((item) => item.id !== proposal.id);
      continue;
    }
    brand = await updateBrandRuleInTransaction(client, viewer, {
      field: proposal.field,
      value: proposal.value,
      version: brand.version,
      commandKey,
    });
    const event = (await client.query<{ id: string }>("SELECT id FROM brand_event WHERE owner_id=$1 AND command_key=$2", [ownerId, commandKey])).rows[0];
    requireCondition(event, "preference_save_failed", "The durable preference could not be recorded with its history.", 500);
    saved.push({ proposalId: proposal.id, eventId: event.id, field: proposal.field, value: proposal.value, evidence: proposal.evidence });
    state.preferenceProposals = state.preferenceProposals?.filter((item) => item.id !== proposal.id);
  }
  if (saved.length) state.autoSavedPreferences = [...(state.autoSavedPreferences ?? []), ...saved];
}

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
