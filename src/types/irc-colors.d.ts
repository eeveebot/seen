declare module 'irc-colors' {
  export function blue(text: string): string;
  export function cyan(text: string): string;
  export function green(text: string): string;
  export function yellow(text: string): string;
  export function orange(text: string): string;
  export function red(text: string): string;
  export function purple(text: string): string;
  export function gray(text: string): string;

  export default {
    blue,
    cyan,
    green,
    yellow,
    orange,
    red,
    purple,
    gray,
  };
}
