'use client';

import { useEffect, useRef, useState } from 'react';
import { useGaze } from '@/lib/gazeContext';

export function GazeCursor() {
  const { gazePositionRef, hoverStateRef } = useGaze();

  const wrapRef  = useRef<HTMLDivElement>(null);
  const ringRef  = useRef<SVGCircleElement>(null);  // dwell progress ring — direct DOM
  const dotsRef  = useRef<SVGGElement>(null);        // crosshair lines colour group

  // React state only for colour transitions (fires on hover in/out — very rare)
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    const CIRC       = 2 * Math.PI * 16;
    let prevHovering = false;
    let prevDwell    = 0;
    let raf: number;

    const update = () => {
      // ── Position (direct DOM, 60 fps, zero React) ──────────────────────────
      if (wrapRef.current) {
        let { x, y } = gazePositionRef.current;
        const snapTarget = hoverStateRef.current.snapTarget;
        
        if (snapTarget) {
          // Snap visually to the target (the button's center)
          x = snapTarget.x;
          y = snapTarget.y;
        }

        wrapRef.current.style.transform = `translate(${x - 30}px, ${y - 30}px)`;
      }

      // ── Dwell ring (direct DOM) ────────────────────────────────────────────
      const { isHovering: hov, dwellPct } = hoverStateRef.current;

      if (ringRef.current && dwellPct !== prevDwell) {
        prevDwell = dwellPct;
        ringRef.current.style.strokeDashoffset = String(CIRC * (1 - dwellPct));
      }

      // ── Colour: only trigger React render on hover transition ──────────────
      if (hov !== prevHovering) {
        prevHovering = hov;
        setIsHovering(hov);
      }

      raf = requestAnimationFrame(update);
    };

    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [gazePositionRef, hoverStateRef]);

  // A high-contrast cursor stands out on all vibrant backgrounds
  const primaryColor = '#FFFFFF'; // White progress ring and crosshair (dark ring + halos keep it readable on any background)
  const hoverColor = '#FFFFFF';
  const col   = isHovering ? hoverColor : primaryColor;
  const dimCol = 'var(--ink)'; // Solid black background ring
  const CIRC  = 2 * Math.PI * 16;

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'fixed',
        top: 0, left: 0,
        width: 60, height: 60,
        pointerEvents: 'none',
        zIndex: 9999,
        willChange: 'transform',
        filter: 'drop-shadow(0 0 1.5px rgba(255,255,255,0.9)) drop-shadow(0 2px 5px rgba(0,0,0,0.55))'
      }}
    >
      <svg width="60" height="60" viewBox="0 0 40 40" fill="none">
        {/* Dwell progress ring (stroke-dashoffset controlled by DOM ref) */}
        <circle
          ref={ringRef}
          cx="20" cy="20" r="16"
          stroke={col}
          strokeWidth={isHovering ? 4 : 2.5}
          strokeDasharray={String(CIRC)}
          strokeDashoffset={String(CIRC)}
          strokeLinecap="round"
          style={{
            transform: 'rotate(-90deg)',
            transformOrigin: '20px 20px',
            transition: 'stroke 0.2s ease, stroke-width 0.2s ease',
          }}
        />

        {/* Static outer ring */}
        <circle cx="20" cy="20" r="11" stroke={dimCol} strokeWidth="2.5"
          style={{ transition: 'stroke 0.2s ease' }} />

        {/* Crosshair lines */}
        <g ref={dotsRef} stroke={col} strokeWidth="2.5"
          style={{ transition: 'stroke 0.2s ease' }}>
          <line x1="20" y1="4"  x2="20" y2="11" />
          <line x1="20" y1="29" x2="20" y2="36" />
          <line x1="4"  y1="20" x2="11" y2="20" />
          <line x1="29" y1="20" x2="36" y2="20" />
        </g>

        {/* Centre dot */}
        <circle cx="20" cy="20" r="3.5" fill={col}
          style={{ transition: 'fill 0.2s ease' }} />
      </svg>
    </div>
  );
}
