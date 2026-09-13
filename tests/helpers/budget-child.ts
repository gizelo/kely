import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { fakeAttempt, fakeResponse } from "./budget-fixture";

const [mode, directory, id, key] = process.argv.slice(2);
const budget = new BudgetStore({ directory, id, purpose: "fake" });
let sends = 0;
const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request) {
  sends++;
  if (mode === "crash-after-success") {
    fakeResponse(request);
    process.stdout.write("fake-provider-success\n");
    process.exit(42);
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  return fakeResponse(request, { full: true });
} });

gateway.dispatch(fakeAttempt(key, "gpt-5.6-terra")).then(() => {
  process.stdout.write(JSON.stringify({ outcome: "completed", sends }));
}).catch((error) => {
  process.stdout.write(JSON.stringify({ outcome: error.code ?? "failure", sends }));
}).finally(() => budget.close());
