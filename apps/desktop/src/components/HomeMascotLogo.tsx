import slyyMarkUrl from "../assets/brand/slyy-mark.svg";

/** Home hero mark: the static Slyy dot (replaces the animated mascot). */
export function HomeMascotLogo() {
  return (
    <span
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      aria-hidden="true"
    >
      <img src={slyyMarkUrl} alt="" width={48} height={48} draggable={false} />
    </span>
  );
}
