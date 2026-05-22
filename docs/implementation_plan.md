# Implementation Plan - Fixing Webview Loading Issue via Premium Sidebar View Provider

This plan addresses the issue where the VS Code extension interface is stuck in a perpetual loading state.

## 🔍 Diagnosis & Analysis

We investigated the codebase and discovered the root cause of the "stuck loading" behavior:
1. **Views Contribution**: In [package.json](file:///home/ubuntu/project/solopreneur-roadmap/package.json), the extension contributes a custom sidebar container (`solopreneur-sidebar-container`) containing a webview view with ID `solopreneur.sidebar`.
2. **Missing Provider Registration**: In [src/extension.ts](file:///home/ubuntu/project/solopreneur-roadmap/src/extension.ts), the extension activates but **never registers a `WebviewViewProvider`** for the view `solopreneur.sidebar`.
3. **Symptom**: When a user installs the extension, VS Code automatically renders a sidebar panel under the custom Activity Bar robot icon. However, because no provider is registered to resolve that webview, VS Code displays an empty pane with a loading spinner that runs infinitely. This leads users to believe the extension failed to load entirely.

---

## 🛠️ Proposed Solution

We will build and register a premium, highly aesthetic **Sidebar Webview Provider** (`SolopreneurSidebarProvider`) to fully resolve this issue. The sidebar will serve as a gorgeous compact control panel for the Solopreneur AI Roadmap.

### 🎨 Sidebar UI Design System (Aesthetic Polish)
*   **Theme Integration**: Seamlessly matching VS Code's editor theme using standard CSS variables (`--vscode-editor-background`, etc.).
*   **Progress Card**: A glassmorphic card at the top displaying the overall roadmap progress (e.g. `2 / 6 Completed`) with a glowing gradient progress bar.
*   **AI Input**: A sleek text input field and a "Generate AI Roadmap" button with micro-animations.
*   **Compact Card List**: A vertical stack of compact glassmorphic task cards. Each card displays:
    *   **Status Glow**: A thin border displaying node status (gray for `Pending`, pulsing cyan for `Running`, glowing emerald for `Completed`, crimson red for `Failed`).
    *   **Task Details**: A compact display of the task ID, Title, and Stage badge.
    *   **Quick Execution**: A small `⚡ Run` button next to actionable nodes.
*   **Full Screen Trigger**: A prominent, sticky, glassmorphic button at the bottom: `🖥️ Open Visual Roadmap Editor` which launches the full-screen interactive roadmap panel.

---

## 📂 Proposed Changes

### Component: VS Code Sidebar Integration

#### [NEW] [sidebarProvider.ts](file:///home/ubuntu/project/solopreneur-roadmap/src/sidebarProvider.ts)
We will create a new class `SolopreneurSidebarProvider` implementing `vscode.WebviewViewProvider`:
*   Handle Webview view lifecycle (`resolveWebviewView`).
*   Receive messages from the sidebar webview (like `getNodes`, `runAgent`, `generateRoadmap`, and `showFullRoadmap`).
*   Post updated nodes list back to the sidebar webview.
*   Serve highly polished CSS & HTML containing our premium Outfit & Inter font setups, glassmorphic cards, progress indicators, and interactive logic.

#### [MODIFY] [extension.ts](file:///home/ubuntu/project/solopreneur-roadmap/src/extension.ts)
*   Import `SolopreneurSidebarProvider` from `./sidebarProvider`.
*   Declare a global `let sidebarProvider: SolopreneurSidebarProvider | null = null;`.
*   In `activate`, instantiate `SolopreneurSidebarProvider` and register it using `vscode.window.registerWebviewViewProvider`.
*   Update `sendNodesToWebview` to synchronize node lists with **both** the full-screen `activePanel` (if open) and the `sidebarProvider`.

---

## ⚙️ Verification Plan

### Automated Build Verification
*   Execute `npm run compile` to verify clean TypeScript compilation without warnings or errors.

### Manual UX Verification
1.  **Sidebar Instantiation**: Open the VS Code window, click the "Solopreneur" robot icon on the Activity Bar, and verify that the sidebar loads **instantly** (no loading spinner).
2.  **Visual Polish**: Check that the seeded default roadmap (6 nodes) is displayed as beautiful glassmorphic cards with glowing border indicators and that the progress bar displays `0% Completed`.
3.  **Cross-Panel Interaction**:
    *   Click `Open Visual Roadmap Editor` at the bottom of the sidebar. Verify the full-screen, high-fidelity visual roadmap opens immediately.
    *   Trigger `⚡ Run Agent` on Task 1 from the sidebar or the main editor. Verify that the node status updates to `Running` (pulsing cyan) **simultaneously in both the sidebar and the main editor**.
    *   Verify the terminal starts executing, writes to the Sentinel file, and updates the task status to `Completed` (glowing emerald) in both UIs.
4.  **AI Generation**:
    *   Enter a project idea in the sidebar's AI prompt input.
    *   Click `Generate AI Roadmap` and check that it generates and populates the new roadmap stages instantly in both the sidebar and the main panel.
