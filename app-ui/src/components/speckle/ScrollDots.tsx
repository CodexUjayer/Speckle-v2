/**
 * Scroll cue: three dots that bounce down in turn, a cascade pointing the way.
 * Replaces the thin "Scroll to begin" thread. Decorative (the page scrolls
 * without it), so it is hidden from assistive tech; the motion is a CSS
 * animation that stops for people who asked for reduced motion.
 */
export default function ScrollDots({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`cue-dots ${className}`}>
      <span className="cue-dot" />
      <span className="cue-dot" />
      <span className="cue-dot" />
    </span>
  );
}
