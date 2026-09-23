/**
 * Routing test cases: the prompt, and the tier a human says should handle it.
 *
 * Single source of truth. These previously lived in three separate scripts
 * with three separate copies of the expected tiers, which is how they drift.
 *
 * `expected` is a hand label, not a model's opinion. Changing one is changing
 * the spec for the router, so change it deliberately.
 */
export const CASES = [
  // ─ TRIVIAL ─
  {
    id: "T01",
    category: "trivial",
    name: "Rename symbol",
    expected: "haiku",
    prompt:
      "Rename the variable `userCount` to `activeUserCount` in src/stats.js. Just show the exact lines to change.",
  },
  {
    id: "T02",
    category: "trivial",
    name: "Fix typo",
    expected: "haiku",
    prompt:
      "Fix the typo in this comment: 'This functon processes user data.' Change 'functon' to 'function'.",
  },
  {
    id: "T03",
    category: "trivial",
    name: "Add TODO comment",
    expected: "haiku",
    prompt:
      "Add a TODO comment above the calculateTotal() function explaining that it doesn't handle negative values.",
  },
  {
    id: "T04",
    category: "trivial",
    name: "List config keys",
    expected: "haiku",
    prompt:
      "What are the valid config keys in a package.json 'devDependencies' field? Just list them.",
  },
  {
    id: "T05",
    category: "trivial",
    name: "Format array",
    expected: "haiku",
    prompt:
      "Reformat this one-line array to be multiline for readability: const items = [1, 2, 3, 4, 5, 6, 7, 8];",
  },
  // ─ TYPICAL ─
  {
    id: "T06",
    category: "typical",
    name: "Implement REST endpoint",
    expected: "sonnet",
    prompt:
      "Create a GET /api/users/:id endpoint that returns a user object. Use Express and return 404 if not found.",
  },
  {
    id: "T07",
    category: "typical",
    name: "Write unit tests",
    expected: "sonnet",
    prompt:
      "Write Jest tests for a validateEmail() function. Cover valid emails, invalid format, and empty string cases.",
  },
  {
    id: "T08",
    category: "typical",
    name: "Localized bug fix",
    expected: "sonnet",
    prompt:
      "The login button doesn't disable after clicking. I found it's missing the isLoading prop. Add it to the JSX.",
  },
  {
    id: "T09",
    category: "typical",
    name: "Add CSS class",
    expected: "sonnet",
    prompt:
      "Add a new .button-primary CSS class with blue background and white text, 8px padding, rounded corners.",
  },
  {
    id: "T10",
    category: "typical",
    name: "Extract function",
    expected: "sonnet",
    prompt:
      "I have 50 lines of validation logic repeated in 3 places. Extract it into a reusable validateForm() function.",
  },
  // ─ COMPLEX ─
  {
    id: "T11",
    category: "complex",
    name: "Debug memory leak",
    expected: "opus",
    prompt:
      "Our app's memory usage grows 50MB/hour. No errors in logs. I've attached heap snapshots. Find the leak.",
  },
  {
    id: "T12",
    category: "complex",
    name: "Auth system design",
    expected: "opus",
    prompt:
      "Design a multi-tenant auth system where each tenant has isolated user data. Consider token issuance, refresh, and RBAC.",
  },
  {
    id: "T13",
    category: "complex",
    name: "Race condition fix",
    expected: "opus",
    prompt:
      "Two requests to create the same resource sometimes both succeed, creating duplicates. Database has a unique constraint. Debug why.",
  },
  {
    id: "T14",
    category: "complex",
    name: "Database migration",
    expected: "opus",
    prompt:
      "Migrate 10M rows to a new schema: split address into address1, address2, city, state. Write a safe migration with rollback.",
  },
  {
    id: "T15",
    category: "complex",
    name: "Performance refactor",
    expected: "opus",
    prompt:
      "API takes 5s for a list endpoint that returns 1000 items. Requests are slow even when results are small. Propose a solution.",
  },
  // ─ TRIVIAL ─
  {
    id: "T16",
    category: "trivial",
    name: "Code snippet answer",
    expected: "haiku",
    prompt:
      "Show me the syntax for a JavaScript arrow function that takes two params and returns their sum.",
  },
  // ─ TYPICAL ─
  {
    id: "T17",
    category: "typical",
    name: "Component refactor",
    expected: "sonnet",
    prompt:
      "Refactor this React class component to a functional component with hooks. It has state, effects, and a ref.",
  },
  // ─ COMPLEX ─
  {
    id: "T18",
    category: "complex",
    name: "Concurrency debugging",
    expected: "opus",
    prompt:
      "The counter in my concurrent Rust app sometimes jumps by 3 instead of 1. Multiple threads increment it. Find the race condition.",
  },
  // ─ TYPICAL ─
  {
    id: "T19",
    category: "typical",
    name: "Add validation",
    expected: "sonnet",
    prompt:
      "Add input validation to a form: email, phone (US), and password (8+ chars, uppercase, number, symbol).",
  },
  // ─ COMPLEX ─
  {
    id: "T20",
    category: "complex",
    name: "System design",
    expected: "opus",
    prompt:
      "Design a notification system that handles millions of events/second, with delivery guarantees and rate-limiting per user.",
  },
  // ─ TRIVIAL ─
  {
    id: "T21",
    category: "trivial",
    name: "Explain error",
    expected: "haiku",
    prompt:
      "What does 'TypeError: Cannot read property of undefined' mean and what usually causes it?",
  },
  // ─ TYPICAL ─
  {
    id: "T22",
    category: "typical",
    name: "Implement caching",
    expected: "sonnet",
    prompt:
      "Add Redis caching to an endpoint that fetches user profiles. Invalidate on profile update, TTL 1 hour.",
  },
  // ─ COMPLEX ─
  {
    id: "T23",
    category: "complex",
    name: "Cluster consensus",
    expected: "opus",
    prompt:
      "Implement Raft consensus in a distributed key-value store. Handle leader election, log replication, and safety.",
  },
  // ─ TYPICAL ─
  {
    id: "T24",
    category: "typical",
    name: "Parse CSV",
    expected: "sonnet",
    prompt:
      "Write a function to parse CSV data with quoted fields and embedded commas. Return an array of objects.",
  },
  // ─ COMPLEX ─
  {
    id: "T25",
    category: "complex",
    name: "Unknown bug investigation",
    expected: "opus",
    prompt:
      "Users report intermittent 500 errors on checkout. No stack trace. Spans microservices (API, payments, inventory). Where do I start?",
  },
];

export const CATEGORIES = ["trivial", "typical", "complex"];
