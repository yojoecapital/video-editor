declare module '*.css'

// React 19 no longer publishes a global JSX namespace; components here use `JSX.Element`.
declare namespace JSX {
  type Element = import('react').JSX.Element
}
