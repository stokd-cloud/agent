# Site-build prompt (Stage 5)

Fill the two placeholders, then execute the prompt below as the build brief.
`[INSERT VIDEO FILENAME]` → the final video's filename (e.g. `capsule.mp4`).
`[INSERT THE VIDEO DESCRIPTION...]` → the concept text plus the generation
prompt for this video.

---

VIDEO_FILENAME: [INSERT VIDEO FILENAME, e.g. capsule.mp4]

CONCEPT:
[INSERT THE VIDEO DESCRIPTION, PRODUCT CONCEPT, BRAND IDEA, OR GENERATION PROMPT HERE]

You are Claude, the sole creative director and senior frontend author for a premium, scroll-driven commercial landing page.

Using the VIDEO_FILENAME and CONCEPT above, design and build one complete production website around the supplied video.

Do not ask follow-up questions. Infer an exceptional brand, commercial purpose, visual identity, narrative, copy and interaction system from the concept.

The result should feel like an award-winning commercial microsite: highly animated and cinematic, but still grounded, legible, commercially plausible and usable.

This is ONE website—not a portfolio and not a collection of worlds.

MEDIA

The supplied video already exists at:

/public/media/[VIDEO_FILENAME]

Reference it in the browser as:

/media/[VIDEO_FILENAME]

Do not generate, download, replace, modify or interpolate the video.

The video's duration may vary. Read its actual duration from loaded metadata rather than hardcoding eight or ten seconds.

STACK

- React 19
- TypeScript
- Vite
- Tailwind CSS v4 using @tailwindcss/vite
- GSAP with ScrollTrigger
- Lenis smooth scrolling
- react-router-dom using BrowserRouter
- lucide-react where appropriate
- Native HTML video
- No canvas-based video rendering

ROUTES

Create exactly these primary routes:

- `/` — the complete commercial landing-page experience
- `/prompt/` — a polished prompt archive containing a self-contained reconstruction prompt that another Claude could use to rebuild the same website

The `/prompt/` route must include:

- The original VIDEO_FILENAME and CONCEPT
- The generated brand and art-direction brief
- The video path
- The complete reconstruction prompt
- Stack and architecture details
- A functioning "Copy Prompt" button
- A clear link back to the experience

Do not create a portfolio index or multiple experiences.

CREATIVE-DIRECTION PHASE

Before writing code, internally derive the following from the supplied concept:

1. A distinctive brand name
2. A specific product, institution or commercial offering
3. A realistic conversion goal
4. A hero headline, subcopy and CTA
5. Four or five narrative chapters corresponding to stages in the video
6. A navigation system physically inspired by the concept
7. A cohesive palette with exact hex values
8. A typography system
9. Five or more signature motion behaviors
10. A strong final commercial climax and CTA

Do not output this planning separately. Express it through the finished implementation and include it on `/prompt/`.

The interface should feel inseparable from the physical material and motion depicted in the film.

Examples:

- A pharmaceutical film might use dosage scales, molecular diagrams, bioavailability readouts and clinical labels.
- A mechanical film might use engraved gauges, exploded diagrams and precision instruments.
- An organic film might use branching structures, growth measurements and living masks.
- An archival film might use registration marks, folio numbers and material annotations.

Do not default to a generic centered hero, SaaS navigation, floating-card layout or interchangeable luxury template.

CORE EXPERIENCE

The root experience should be approximately 500vh tall, adjusted when necessary to support the narrative.

The supplied video must remain fixed and full-screen behind the interface.

Scrolling from the top to the bottom must scrub the video from its first frame to its final frame.

The page-specific interface should animate through synchronized chapters over the film.

The film is the spatial world. The interface should explain, annotate and dramatize the journey without covering it unnecessarily.

SCROLL VIDEO ENGINE

Create a production-grade `ScrollVideo` component.

Requirements:

- Render the video using a native `<video>` element
- Fixed, full-viewport positioning
- `object-fit: cover`
- `muted`
- `playsInline`
- `preload="auto"`
- `disablePictureInPicture`
- Read the actual duration from `loadedmetadata`
- Map total document progress to `video.currentTime`
- ScrollTrigger updates should only set a target playback time
- Use one `requestAnimationFrame` loop to ease an internal playhead toward that target
- Use frame-rate-independent exponential damping
- Never issue a new seek while the decoder is already seeking
- While seeking, retain only the newest requested target
- Drain pending seeks through `seeked`
- Use `requestVideoFrameCallback` where it improves decoder safety
- Never build an unbounded seek queue
- Prevent stale queued values from moving the film backward
- Avoid repeatedly calling `ScrollTrigger.refresh`
- Include a restrained loading overlay and buffered-progress indicator
- Include subtle desktop mouse parallax
- Disable parallax on touch devices
- Handle loading and media errors gracefully
- Remain safe under React StrictMode
- Do not remove the video `src` during StrictMode cleanup
- Support Safari and iOS
- Respect `prefers-reduced-motion`
- Expose the important damping and seek thresholds as documented constants

SMOOTH SCROLLING

Create a global `SmoothScroll` component using Lenis.

Requirements:

- Lenis must be driven exclusively through GSAP's ticker
- Do not create a second independent RAF loop for Lenis
- Forward Lenis scroll events to `ScrollTrigger.update`
- Keep every page-specific ScrollTrigger synchronized
- Preserve keyboard scrolling
- Preserve anchor navigation
- Preserve browser accessibility
- Reset scroll cleanly on route changes
- Disable decorative smoothing under `prefers-reduced-motion`
- Ensure setup and cleanup are StrictMode-safe
- Export a minimal imperative scrolling API for Auto Tour

AUTO TOUR

Create a minimal fixed Auto Tour control on `/`.

It must not appear on `/prompt/`.

Requirements:

- Initial state: "Start Tour"
- Running state: "Pause"
- Paused state: "Resume"
- Completed state: "Replay"
- Show live percentage progress
- Include Restart once progress exceeds 2%
- Include a clean 1× / 2× speed toggle
- 1× completes the entire page in exactly 20 seconds
- 2× completes it in exactly 10 seconds
- Progress must be normalized regardless of document height
- Use a linear GSAP tween
- Drive the Lenis scrolling API
- Manual wheel input pauses the tour
- Touch input pauses the tour
- Pointer dragging outside the control pauses the tour
- PageUp, PageDown, Home, End, Space and arrow scrolling pause it
- Escape stops the tour without resetting the user's scroll position
- Route changes kill all active tweens
- Do not trigger React re-renders on every animation frame
- Update progress through refs or CSS custom properties
- Include visible keyboard focus and an aria-live status
- Use restrained neutral styling that complements the generated design

PAGE-SPECIFIC EXPERIENCE

Create a dedicated experience component and stylesheet derived from the concept.

Suggested paths:

- `src/experience/Experience.tsx`
- `src/experience/Experience.css`

The component must contain:

- A distinctive hero composition
- Concept-specific navigation
- Four or five scroll chapters
- Scroll-synchronized typography
- Concept-specific measurements, annotations or instruments
- At least one meaningful SVG visualization
- At least one lightweight interactive element
- A commercial final section
- A clear CTA
- A link to `/prompt/`
- A discreet way to return to the beginning

Use GSAP timelines scoped through `gsap.context`.

All timelines, event listeners, RAF callbacks and ScrollTriggers must be cleaned up correctly.

The interface should evolve with the visual stages described in the supplied CONCEPT. Do not place unrelated animations over the video.

MOTION QUALITY

Motion should feel continuous, cinematic and physically motivated.

Use techniques such as:

- Masks and clipping reveals
- Typographic splitting and recomposition
- SVG measurement instruments
- Scroll-responsive counters
- Parallax with restrained depth
- Material-specific wipes
- Chapter-based palette changes
- Animated leader lines and annotations
- Progress systems inspired by the concept
- Cursor-responsive details on desktop

Avoid:

- Random floating UI
- Excessive glassmorphism
- Constant blur
- Gratuitous gradient blobs
- Generic feature cards
- Template-like SaaS sections
- Animating every element
- Scroll hijacking
- Fake loading delays
- Motion unrelated to the film
- Large opaque panels that obscure the video
- Horizontal overflow

COMMERCIAL WRITING

Write all finished website copy.

The copy must be:

- Specific to the inferred brand
- Concise
- Credible
- Editorial rather than generic
- Suitable for a real commercial site
- Free from lorem ipsum
- Free from vague AI marketing language

If the concept touches health, cosmetics, finance or another regulated category, keep claims commercially compelling but appropriately qualified. Do not invent clinical proof, certifications or guaranteed outcomes.

DESIGN QUALITY

- Award-level commercial microsite
- Grounded and usable
- Strong typographic hierarchy
- Visually impressive without becoming experimental nonsense
- Intentional negative space
- Film remains the primary visual anchor
- Fully responsive
- Desktop and mobile must both feel authored
- No horizontal overflow
- No tiny unreadable labels
- No generic navigation template
- No external frontend design skill
- Do not copy an existing brand

ACCESSIBILITY

- Semantic HTML
- Keyboard-operable controls
- Visible focus states
- Sufficient contrast
- Useful ARIA labels
- Decorative elements hidden from assistive technology
- Respect reduced motion
- Avoid focus traps
- Ensure interactive elements are real buttons or links

PROJECT ARCHITECTURE

Create all files required for a complete standalone project, including:

- `package.json`
- `index.html`
- `vite.config.ts`
- `tsconfig.json`
- `tsconfig.app.json`
- `tsconfig.node.json`
- `src/main.tsx`
- `src/App.tsx`
- `src/index.css`
- `src/components/ScrollVideo.tsx`
- `src/components/SmoothScroll.tsx`
- `src/components/AutoTour.tsx`
- `src/components/AutoTour.css`
- `src/components/PromptPage.tsx`
- `src/components/SiteChrome.tsx` if useful
- `src/experience/Experience.tsx`
- `src/experience/Experience.css`
- Any small supporting type or data files genuinely needed

Do not create unnecessary abstractions for multiple worlds.

Do not create placeholder components.

Do not leave TODO comments.

Do not omit styles.

Do not reference nonexistent assets other than the supplied video.

Use CSS, SVG and browser-native capabilities for supporting visuals.

IMPLEMENTATION REQUIREMENTS

- Wrap the application in `<StrictMode>` and `<BrowserRouter>`
- Ensure direct navigation to `/prompt/` works
- Configure SPA redirects when necessary
- Ensure `npm run build` succeeds
- Resolve all TypeScript errors
- Avoid unused imports
- Avoid runtime console errors
- Avoid duplicated GSAP registration
- Keep page-specific code separate from shared scrolling infrastructure
- Do not alter or regenerate the supplied video

RECONSTRUCTION PROMPT

Create a self-contained reconstruction prompt for `/prompt/`.

It must include enough detail for a future Claude to recreate:

- The brand
- The page narrative
- The hero and chapter content
- The visual system
- The navigation concept
- Signature interactions
- The supplied video filename and path
- The technical stack
- The scroll-video behavior
- Smooth scrolling
- Auto Tour behavior
- Responsive and accessibility requirements

Do not merely display this instruction verbatim. Produce a clean, concept-specific reconstruction brief.

FINAL INSTRUCTION

Build the complete working project now.

If filesystem tools are available, create and edit the files directly and run `npm run build`.

Otherwise, output ONLY a complete unified diff from an empty directory.

Do not provide explanations, progress commentary, markdown fences or abbreviated files.

Do not stop after creating the foundation.

The final result must include the complete page-specific experience, styling, `/prompt/` route, ScrollVideo system, SmoothScroll system and Auto Tour in this single response.
