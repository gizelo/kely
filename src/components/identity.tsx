export function KelyLogo({ small = false }: { small?: boolean }) {
  return (
    <span className={"kely-logo" + (small ? " kely-logo-small" : "")}>
      kely
    </span>
  );
}
