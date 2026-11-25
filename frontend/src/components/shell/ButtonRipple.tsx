"use client";

import { useEffect } from "react";

/** 波紋の対象: ボタン類とサイドバー等のナビゲーションリンク */
const SELECTOR =
  'button:not([data-no-ripple]), [role="button"]:not([data-no-ripple]), nav a[href]:not([data-no-ripple])';

/**
 * 全ボタンに押下波紋 (広がる円) を付ける。yexe.netのbutton-rippleプラグインと同型。
 * ドキュメント単位のイベント委譲なので個別コンポーネントの改修は不要。
 * prefers-reduced-motion時はスケールせずフェードのみ。
 */
export default function ButtonRipple() {
  useEffect(() => {
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const running = new Map<Animation, { layer: HTMLElement; pointerId?: number }>();

    const ripple = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof PointerEvent && (event.button !== 0 || !event.isPrimary)) return;
      if (event instanceof KeyboardEvent && (event.repeat || !["Enter", " "].includes(event.key))) {
        return;
      }
      const host = (event.target as Element)?.closest<HTMLElement>(SELECTOR);
      if (
        !host ||
        host.closest("[inert], [data-no-ripple]") ||
        host.matches(':disabled, [aria-disabled="true"]')
      ) {
        return;
      }
      // リンクへのSpaceはスクロール操作なので除外 (Enterは押下として扱う)
      if (
        event instanceof KeyboardEvent &&
        event.key === " " &&
        host.matches('a[href]:not([role="button"])')
      ) {
        return;
      }
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = event instanceof PointerEvent ? event.clientX - rect.left : rect.width / 2;
      const y = event instanceof PointerEvent ? event.clientY - rect.top : rect.height / 2;
      const diameter = 2 * Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
      if (getComputedStyle(host).position === "static") host.classList.add("ripple-relative");

      const layer = document.createElement("span");
      layer.className = "button-ripple-layer";
      layer.setAttribute("aria-hidden", "true");
      const circle = document.createElement("span");
      circle.className = "button-ripple-circle";
      Object.assign(circle.style, {
        width: `${diameter}px`,
        height: `${diameter}px`,
        left: `${x - diameter / 2}px`,
        top: `${y - diameter / 2}px`,
      });
      layer.append(circle);
      host.append(layer);

      const animation = circle.animate(
        reducedMotion.matches
          ? [{ opacity: 0.14 }, { opacity: 0 }]
          : [
              { transform: "scale(0)", opacity: 0.24 },
              { transform: "scale(1)", opacity: 0.15, offset: 0.65 },
              { transform: "scale(1)", opacity: 0 },
            ],
        {
          duration: reducedMotion.matches ? 160 : 480,
          easing: "cubic-bezier(.16, 1, .3, 1)",
          fill: "forwards",
        },
      );
      running.set(animation, {
        layer,
        pointerId: event instanceof PointerEvent ? event.pointerId : undefined,
      });
      const remove = () => {
        layer.remove();
        running.delete(animation);
      };
      animation.onfinish = remove;
      animation.oncancel = remove;
    };

    // ドラッグ開始等でポインターが消えたら波紋も打ち切る (カード並べ替え用)
    const cancel = (event: PointerEvent) => {
      for (const [animation, { layer, pointerId }] of running) {
        if (pointerId !== event.pointerId) continue;
        animation.cancel();
        layer.remove();
        running.delete(animation);
      }
    };

    document.addEventListener("pointerdown", ripple);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", ripple);
    return () => {
      document.removeEventListener("pointerdown", ripple);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", ripple);
      for (const [animation, { layer }] of running) {
        animation.cancel();
        layer.remove();
      }
      running.clear();
    };
  }, []);

  return null;
}
