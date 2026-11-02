import { execFileSync } from 'node:child_process';

export default function setup() {
  execFileSync('yarn', ['build:prod'], { stdio: 'inherit' });
}
