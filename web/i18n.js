// UI language: the browser's, or ?lang=xx in the link. English text is the key; other languages map it.
// Add a language: copy the "es" block, translate the right-hand side.

import { FEEDBACK_ES } from "./feedback.js";

const DICT = {
  es: { // Spanish as spoken in Argentina (vos)
    ...FEEDBACK_ES,
    "Report a problem or idea": "Contar un problema o una idea",
    "Feedback": "Comentarios",
    "Include technical details": "Incluir detalles técnicos",
    "Ronda · free live quizzes and polls": "Ronda · preguntas y encuestas en vivo, gratis",
    "Enter the code from the screen": "Escribí el código de la pantalla",
    "Join": "Entrar",
    "Make a quiz or poll": "Crear una trivia o encuesta",
    "Your rondas": "Tus rondas",
    "Free, no account, no player limit": "Gratis, sin cuenta, sin límite de jugadores",
    "Open source": "Código abierto",
    "Free, no account, no player limit · Open source": "Gratis, sin cuenta, sin límite de jugadores · Código abierto",
    "Privacy": "Privacidad",
    "Your name": "Tu nombre",
    "Go": "Listo",
    "Back": "Volver",
    "Code": "Código",
    "Title": "Título",
    "Add": "Agregar",
    "Quiz": "Trivia",
    "Poll": "Encuesta",
    "Words": "Palabras",
    "Scale": "Escala",
    "Type answer": "Escribir la respuesta",
    "Put in order": "Ordenar",
    "Ask a question people answer by typing": "Hacé una pregunta que se responde escribiendo",
    "Ask people to put things in order": "Pedí que ordenen cosas",
    "Also accepted (optional)": "También vale (opcional)",
    "The right answer": "La respuesta correcta",
    "Capitals, accents and spaces don't matter. Add other spellings that also count.": "No importan mayúsculas, tildes ni espacios. Agregá otras formas de escribirla que también valgan.",
    "Number {n} in the order": "Número {n} del orden",
    "Number {n} (optional)": "Número {n} (opcional)",
    "Write them in the right order. Everyone sees them mixed up and puts them back.": "Escribilos en el orden correcto. Todos los ven mezclados y los tienen que ordenar.",
    "Question {n} needs the right answer": "A la pregunta {n} le falta la respuesta correcta",
    "Type your answer": "Escribí tu respuesta",
    "Tap them in the right order": "Tocalos en el orden correcto",
    "The right order:": "El orden correcto:",
    "Type your answer on your phone": "Escribí tu respuesta en el celular",
    "Also counted: {a}": "También valía: {a}",
    "{r} of {n} got it right": "{r} de {n} acertaron",
    "{r} of {n} got the order right": "{r} de {n} acertaron el orden",
    "Share": "Compartir",
    "Delete": "Borrar",
    "Start": "Empezar",
    "Full screen": "Pantalla completa",
    "A lot": "Mucho",
    "A ronda to use or copy: {title}": "Una ronda para usar o copiar: {title}",
    "Add a question first": "Primero agregá una pregunta",
    "Another word (optional)": "Otra palabra (opcional)",
    "Answer {l} (optional)": "Respuesta {l} (opcional)",
    "Answer {l}": "Respuesta {l}",
    "Ask a question with a right answer": "Hacé una pregunta con una respuesta correcta",
    "Ask for a rating from 1 to 5": "Pedí una nota del 1 al 5",
    "Ask for a word or two": "Pedí una o dos palabras",
    "Ask what people think": "Preguntá qué opina la gente",
    "Average {v}": "Promedio {v}",
    "Back to start": "Volver al inicio",
    "Close the room": "Cerrar la sala",
    "Code {code}": "Código {code}",
    "Couldn't start. Check the internet and try again.": "No se pudo empezar. Revisá internet y probá de nuevo.",
    "Deleted": "Borrada",
    "Download results": "Descargar resultados",
    "Everyone can send up to 3 words. They show as a word cloud.": "Cada uno puede mandar hasta 3 palabras. Se ven como una nube de palabras.",
    "Everyone picks 1 to 5. Shows the average.": "Cada uno elige del 1 al 5. Se ve el promedio.",
    "Finish": "Terminar",
    "Finished!": "¡Terminó!",
    "Join at {site} with the code": "Entrá a {site} con el código",
    "Joining…": "Entrando…",
    "Link copied. Anyone who opens it gets their own copy.": "Enlace copiado. Quien lo abra recibe su propia copia.",
    "Look at the screen for the results.": "Mirá la pantalla para ver los resultados.",
    "Look at the screen. It starts soon.": "Mirá la pantalla. Ya empieza.",
    "Move down": "Bajar",
    "Move up": "Subir",
    "Name": "Nombre",
    "Next question": "Siguiente pregunta",
    "No answer this time": "Esta vez no respondiste",
    "No timer": "Sin tiempo",
    "Not at all": "Nada",
    "Not this time": "Esta vez no",
    "Open a file…": "Abrir un archivo…",
    "Opening the room…": "Abriendo la sala…",
    "Points": "Puntos",
    "Question {i} of {n}": "Pregunta {i} de {n}",
    "Question {n} has no text": "La pregunta {n} no tiene texto",
    "Question {n} needs at least 2 answers": "La pregunta {n} necesita al menos 2 respuestas",
    "Question {n}: tap ✓ on the right answer": "Pregunta {n}: tocá ✓ en la respuesta correcta",
    "Ranking": "Ranking",
    "Remove question": "Quitar pregunta",
    "Remove {name}?": "¿Sacar a {name}?",
    "Results saved to your downloads": "Los resultados se guardaron en tus descargas",
    "Right answer": "Respuesta correcta",
    "Right answer: {a}": "Respuesta correcta: {a}",
    "Right!": "¡Correcto!",
    "Saved to your rondas": "Guardada en tus rondas",
    "Saved": "Guardado",
    "Saving…": "Guardando…",
    "Send": "Enviar",
    "Sent. Look at the screen.": "Enviado. Mirá la pantalla.",
    "Sent. Wait for the others.": "Enviado. Esperá a los demás.",
    "Sent. You can change it until the results.": "Enviado. Podés cambiarlo hasta que salgan los resultados.",
    "Show results": "Ver resultados",
    "Something in this ronda can't be used": "Algo de esta ronda no se puede usar",
    "Tap again to delete": "Tocá otra vez para borrar",
    "Tap ✓ on the right answer. Faster right answers get more points.": "Tocá ✓ en la respuesta correcta. Quien acierta más rápido suma más puntos.",
    "Thanks for taking part": "Gracias por participar",
    "Thanks!": "¡Gracias!",
    "Thanks, everyone!": "¡Gracias a todos!",
    "That file isn't a ronda": "Ese archivo no es una ronda",
    "That link is broken": "Ese enlace está roto",
    "The code has 6 numbers": "El código tiene 6 números",
    "The host removed you from this ronda.": "Quien organiza te sacó de esta ronda.",
    "This ronda has already finished.": "Esta ronda ya terminó.",
    "This ronda has ended": "Esta ronda terminó",
    "This ronda has ended. Thanks for playing!": "Esta ronda terminó. ¡Gracias por jugar!",
    "This ronda is full ({max} people)": "Esta ronda está llena ({max} personas)",
    "This screen isn't hosting that ronda": "Esta pantalla no está presentando esa ronda",
    "Time to answer": "Tiempo para responder",
    "Top 5": "Los 5 primeros",
    "Type a word": "Escribí una palabra",
    "Untitled": "Sin título",
    "Wait for people to join first": "Primero esperá a que entre gente",
    "Waiting for answers…": "Esperando respuestas…",
    "Waiting for people…": "Esperando gente…",
    "You came {rank} of {of} with {n} points": "Saliste {rank} de {of} con {n} puntos",
    "You're in!": "¡Ya estás!",
    "You're {rank}": "Vas {rank}",
    "or scan this with the phone camera": "o escaneá esto con la cámara del celular",
    "results": "resultados",
    "{a} of {n} answered": "{a} de {n} respondieron",
    "{n} people are in. Tap a name to remove it.": "Hay {n} personas. Tocá un nombre para sacarlo.",
    "{n} people": "{n} personas",
    "{n} points": "{n} puntos",
    "{n} questions": "{n} preguntas",
    "{s} s": "{s} s",
  },
};

function pick() {
  const asked = new URLSearchParams(location.search).get("lang");
  if (asked) {
    try { localStorage.setItem("lang", asked); } catch {}
  }
  const want = [asked, safeGet("lang"), ...(navigator.languages || [navigator.language])].filter(Boolean);
  for (const l of want) {
    const base = String(l).toLowerCase().split("-")[0];
    if (base === "en") return "en";
    if (DICT[base]) return base;
  }
  return "en";
}

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

export const LANG = pick();
const table = DICT[LANG] || {};

/** t("{name} left", { name }) -> the text in the UI language, placeholders filled. */
export function t(text, vars) {
  let s = table[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translates the static page: text nodes and title / placeholder / alt attributes. */
export function translatePage(root = document) {
  document.documentElement.lang = LANG;
  if (LANG === "en") return;
  document.title = t(document.title);
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue;
    const s = raw.trim();
    if (!s) continue;
    // "Open source · <a>" keeps its separator
    const core = s.replace(/\s*·\s*$/, "");
    if (table[core]) n.nodeValue = raw.replace(core, table[core]);
  }
  for (const el of (root.body || root).querySelectorAll("[title],[placeholder]")) {
    for (const a of ["title", "placeholder"]) if (el.hasAttribute(a)) el.setAttribute(a, t(el.getAttribute(a)));
  }
}
