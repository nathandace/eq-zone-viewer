// Gamepad support: left stick moves, right stick looks, A jumps / flies up, B flies down, bumpers sprint
// and creep, Y toggles walk mode, Start toggles the menu. Standard-mapping pads only.
import type { ViewerCtx } from './context.ts';

const DEAD = 0.25;

export function initGamepad(ctx: ViewerCtx): void {
  const held = new Set<string>();
  const pressed = new Set<number>();
  let announced = false;

  function hold(code: string, down: boolean): void {
    if (down && !held.has(code)) held.add(code);
    if (!down && held.has(code)) held.delete(code);
    ctx.holdKey(code, down);
  }

  function edge(gp: Gamepad, button: number): boolean {
    const down = !!gp.buttons[button]?.pressed;
    const was = pressed.has(button);
    if (down) pressed.add(button);
    else pressed.delete(button);
    return down && !was;
  }

  ctx.events.on('frame', (dt) => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p) => p && p.connected && p.mapping === 'standard') ?? Array.from(pads).find((p) => p && p.connected);
    if (!gp) {
      if (held.size) for (const k of [...held]) hold(k, false);
      return;
    }
    if (!announced) {
      announced = true;
      console.log(`[gamepad] ${gp.id}`);
      ctx.setStatus(`Gamepad connected: ${gp.id.slice(0, 40)}`);
    }
    const lx = gp.axes[0] ?? 0;
    const ly = gp.axes[1] ?? 0;
    const rx = gp.axes[2] ?? 0;
    const ry = gp.axes[3] ?? 0;
    hold('KeyW', ly < -DEAD);
    hold('KeyS', ly > DEAD);
    hold('KeyA', lx < -DEAD);
    hold('KeyD', lx > DEAD);
    hold('Space', !!gp.buttons[0]?.pressed || (gp.buttons[7]?.value ?? 0) > 0.5);
    hold('KeyC', !!gp.buttons[1]?.pressed || (gp.buttons[6]?.value ?? 0) > 0.5);
    hold('ShiftLeft', !!gp.buttons[5]?.pressed);
    hold('ControlLeft', !!gp.buttons[4]?.pressed);
    if (Math.abs(rx) > DEAD || Math.abs(ry) > DEAD) {
      const yaw = ctx.yaw() - (Math.abs(rx) > DEAD ? rx * 2.2 * dt : 0);
      const pitch = Math.max(-1.55, Math.min(1.55, ctx.pitch() - (Math.abs(ry) > DEAD ? ry * 1.6 * dt : 0)));
      ctx.setView(yaw, pitch);
    }
    if (edge(gp, 3)) ctx.setWalkMode(!ctx.walking());
    if (edge(gp, 9)) document.body.classList.toggle('menu-collapsed');
    if (edge(gp, 2)) ctx.returnToStart();
  });
}
