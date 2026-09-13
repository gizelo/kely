import { KelyApp } from "../components/kely-app";
import { config } from "../server/config";

export const dynamic = "force-dynamic";

export default function Page() {
  return <KelyApp inviteOnly={config.cloud} />;
}
