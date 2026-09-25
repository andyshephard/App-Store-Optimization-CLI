# Keyword difficulty model (ratings mode)

`cli/services/cache-api/services/aso-rating-difficulty.ts` scores difficulty from
the rating counts of a keyword's top 10 search results. It is fitted to Astro
(tryastro.app), used as the reference with the developer's consent, by
black-box observation of its scores — no decompilation.

## Formula

```
s_i        = clamp(log10(1 + ratingCount_i), 1, 6)   for each of the top 10 results
sorted     = s sorted strongest → weakest
difficulty = round(clamp(Σ w_k · sorted_k + 0.0244 · resultCount − 23.402, 5, 100))
w          = [2.525, 2.531, 3.034, 2.03, 1.559, 1.618, 1.23, 1.156, 1.294, 1.656]
```

## Evidence (2026-09-25)

- 2,138 US keywords (ASCII only) whose Astro score and stored result list were
  captured in the same refresh. 5-fold cross-validated: MAE 3.46, 47% within
  ±2, 80% within ±5. A gradient-boosted model on the same inputs reaches MAE
  2.76, so there is a little left to find.
- Astro is deterministic: 108/108 keywords tracked under two apps scored
  identically.
- Only the top 10 matter (10 beat 5, 8, 12, 15, 20+). Title/subtitle match,
  average rating, star histogram, age, chart position and popularity add
  ~nothing. Rating counts saturate around 1M. Sorting by strength beats search
  position.

## Inputs and the order source

Astro scores the list it stores, and that list is Apple's catalog search API
order (`amp-api-search-edge.apps.apple.com/v1/catalog/{cc}/search`) — identical
to the apps.apple.com search page, which now only renders ~11 results.
MZSearch (`search.itunes.apple.com/.../MZSearch.woa`), which ratings mode uses
today, returns ~250 results but its order drifts from the App Store's after the
first 2–14 positions. Top-10 rating counts from iTunes lookup are identical to
Astro's.

Measured on 40 Chunks keywords: 1.2 s per keyword, 0 errors, difficulty MAE
4.65 vs Astro, exact rank match 18/40 (rank drift comes from MZSearch order).
