// Home page: the game card floats while hovered, then eases back down from
// wherever it was mid-float instead of snapping.
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
