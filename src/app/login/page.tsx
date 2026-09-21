import { KelyApp } from "../../components/kely-app";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <KelyApp inviteOnly initialView="auth" />;
}
