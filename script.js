// script.js
// -----------------------------------------------------------------------
// Main JavaScript file for the site.
// Currently the nav links are placeholders (href="#"), so there's no
// interactive behavior wired up yet. Use this file to add functionality
// as the site grows.
// -----------------------------------------------------------------------

// Wait for the DOM to finish loading before running anything.
document.addEventListener('DOMContentLoaded', () => {

  const gameCard = document.querySelector('.game-card');

  if (gameCard) {
    gameCard.addEventListener('pointerenter', () => {
      gameCard.style.removeProperty('transform');
      gameCard.classList.add('is-hovering');
    });

    gameCard.addEventListener('pointerleave', () => {
      const currentTransform = getComputedStyle(gameCard).transform;

      gameCard.classList.remove('is-hovering');
      gameCard.style.transform = currentTransform;

      requestAnimationFrame(() => {
        gameCard.style.transform = 'translateY(0)';
      });

      gameCard.addEventListener('transitionend', () => {
        gameCard.style.removeProperty('transform');
      }, { once: true });
    });
  }

  // TODO: Wire up nav links once real pages/sections exist.
  // e.g. smooth-scroll to sections, or handle client-side routing.

  // TODO: Add a mobile nav toggle if the header nav needs a hamburger
  // menu on smaller screens.

  // TODO: Add any page-specific interactivity here (form handling,
  // animations, fetch calls, etc.) as the site's features are built out.

  console.log('script.js loaded');

});
