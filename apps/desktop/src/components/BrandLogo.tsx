// The Slyy mark: one brand-blue dot, identical in light and dark (slyy.ai).
import slyyMarkUrl from "../assets/brand/slyy-mark.svg";

export function BrandLogo({ size = 16 }: { size?: number }) {
  return (
    <img
      className="brand-logo"
      src={slyyMarkUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
