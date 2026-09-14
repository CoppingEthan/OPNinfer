/**
 * Welcome-back greetings shown on the empty chat screen. One is picked at
 * random on each load. `{name}` is replaced with the user's first name; when
 * no name is known the chat window falls back to a generic greeting instead.
 */
export const WELCOME_MESSAGES: string[] = [
  "{name} returns!",
  "Welcome back, {name}.",
  "Good to see you, {name}.",
  "Ready when you are, {name}.",
  "Where were we, {name}?",
  "Let's get to work, {name}.",
  "{name} is back in the building.",
  "Hello again, {name}.",
  "Missed you, {name}.",
  "What's on your mind, {name}?",
  "The one and only {name}.",
  "Look who it is — {name}!",
  "{name} has entered the chat.",
  "Back for more, {name}?",
  "At your service, {name}.",
  "Let's make something great, {name}.",
  "{name}, right on time.",
  "Fancy seeing you here, {name}.",
  "Welcome aboard, {name}.",
  "{name}! Just in time.",
  "Ready to dive in, {name}?",
  "Great to have you back, {name}.",
  "{name} reporting for duty.",
  "How can I help today, {name}?",
  "Let's pick up where we left off, {name}.",
  "{name}, what are we building?",
  "Good to have you, {name}.",
  "The legend returns — {name}.",
  "{name}, let's begin.",
  "Welcome home, {name}.",
  "Always a pleasure, {name}.",
  "{name} is in the house.",
  "Ready and waiting, {name}.",
  "What shall we tackle, {name}?",
  "{name}, the floor is yours.",
  "Here we go again, {name}.",
  "Lovely to see you, {name}.",
  "{name} strikes again.",
  "Let's get started, {name}.",
  "Back at it, {name}?",
  "{name}, your move.",
  "Hello there, {name}.",
  "{name} has arrived.",
  "Time to create, {name}.",
  "{name}, ready to roll?",
  "Good to see you again, {name}.",
  "Let's do this, {name}.",
  "{name}, what's the plan?",
  "Welcome back to the workshop, {name}.",
  "Onwards, {name}.",
];

/** Fill a welcome template with the user's name. */
export function formatWelcome(template: string, name: string): string {
  return template.replace(/\{name\}/g, name);
}
