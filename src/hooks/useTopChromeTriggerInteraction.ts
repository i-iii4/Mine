import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";

type InputModality = "pointer" | "keyboard";

interface UseTopChromeTriggerInteractionOptions {
  dragDisabled?: boolean;
  deferPointerOpen?: boolean;
  onPointerOpen?: () => void;
}

function isModifierOnlyKey(key: string): boolean {
  return key === "Alt" || key === "Control" || key === "Meta" || key === "Shift";
}

function isMenuOpenKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp";
}

export function useTopChromeTriggerInteraction({
  dragDisabled = false,
  deferPointerOpen = false,
  onPointerOpen,
}: UseTopChromeTriggerInteractionOptions = {}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastInputModalityRef = useRef<InputModality>("pointer");
  const openModalityRef = useRef<InputModality>("pointer");
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const {
    onClickCapture: onChromeClickCapture,
    onPointerDownCapture: onChromePointerDownCapture,
  } = useChromeDragGesture({ disabled: dragDisabled });

  useEffect(() => {
    const handlePointerInput = () => {
      lastInputModalityRef.current = "pointer";
    };
    const handleKeyboardInput = (event: KeyboardEvent) => {
      if (isModifierOnlyKey(event.key)) return;
      lastInputModalityRef.current = "keyboard";
    };

    window.addEventListener("pointerdown", handlePointerInput, true);
    window.addEventListener("keydown", handleKeyboardInput, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerInput, true);
      window.removeEventListener("keydown", handleKeyboardInput, true);
    };
  }, []);

  const handlePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    lastInputModalityRef.current = "pointer";
    openModalityRef.current = "pointer";
    setKeyboardFocus(false);
    onChromePointerDownCapture(event);
    if (deferPointerOpen && !dragDisabled && event.button === 0 && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [deferPointerOpen, dragDisabled, onChromePointerDownCapture]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    onChromeClickCapture(event);
    if (event.defaultPrevented) return;
    if (!deferPointerOpen || lastInputModalityRef.current !== "pointer") return;

    event.preventDefault();
    event.stopPropagation();
    openModalityRef.current = "pointer";
    onPointerOpen?.();
  }, [deferPointerOpen, onChromeClickCapture, onPointerOpen]);

  const handleKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isModifierOnlyKey(event.key)) return;
    lastInputModalityRef.current = "keyboard";
    setKeyboardFocus(true);
    if (isMenuOpenKey(event.key)) {
      openModalityRef.current = "keyboard";
    }
  }, []);

  const handleFocus = useCallback((_event: ReactFocusEvent<HTMLButtonElement>) => {
    setKeyboardFocus(lastInputModalityRef.current === "keyboard");
  }, []);

  const handleBlur = useCallback((_event: ReactFocusEvent<HTMLButtonElement>) => {
    setKeyboardFocus(false);
  }, []);

  const handleCloseAutoFocus = useCallback((event: Event) => {
    if (openModalityRef.current === "keyboard") {
      setKeyboardFocus(true);
      return;
    }

    event.preventDefault();
    triggerRef.current?.blur();
    setKeyboardFocus(false);
  }, []);

  return {
    keyboardFocus,
    handleCloseAutoFocus,
    triggerProps: {
      ref: triggerRef,
      "data-top-chrome-keyboard-focus": keyboardFocus ? "true" : undefined,
      onClickCapture: handleClickCapture,
      onPointerDownCapture: handlePointerDownCapture,
      onKeyDownCapture: handleKeyDownCapture,
      onFocus: handleFocus,
      onBlur: handleBlur,
    },
  };
}
