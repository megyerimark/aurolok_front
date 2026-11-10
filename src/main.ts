import './ui/styles.css';
import { Game } from './game/Game';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

try {
  new Game(app, ui);
} catch (err) {
  // WebGL unavailable or a fatal init error: say so instead of a black screen.
  ui.innerHTML = `<div class="screen"><div class="title"><h1 style="font-size:24px">CANNOT START</h1><div class="small">${String(err)}</div></div></div>`;
  throw err;
}
