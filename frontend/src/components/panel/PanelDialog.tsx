/** Modal shell for the panel cluster: scrim + keyline dialog. Handles
 * Escape, backdrop-mousedown close, and body scroll lock. Render inside
 * `<AnimatePresence>` so the entrance/exit motion plays. */

import { motion } from "motion/react";
import { useEffect, type ReactNode } from "react";

interface PanelDialogProps {
  ariaLabel: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}

export function PanelDialog({ ariaLabel, onClose, wide = false, children }: PanelDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <motion.div
      className="scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`dialog${wide ? " dialog--wide" : ""}`}
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.99 }}
        transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
