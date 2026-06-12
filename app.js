const canvas = document.getElementById("simCanvas");
const ctx = canvas.getContext("2d");

const speedInput = document.getElementById("speedInput");
const speedValue = document.getElementById("speedValue");
const fullscreenButton = document.getElementById("fullscreenButton");
const settingsButton = document.getElementById("settingsButton");
const networkToggle = document.getElementById("networkToggle");
const catModeToggle = document.getElementById("catModeToggle");
const arenaPanel = document.querySelector(".arena-panel");
const WORLD = BIOSIM_CONFIG.world;
const SPAWNER_DEFAULTS = BIOSIM_CONFIG.spawners;
const SPAWNER_KINDS = ["herbivore", "carnivore", "plant"];
const DEBUG_MODE_ENABLED = false;

const state = {
  width: 0,
  height: 0,
  plants: [],
  bodies: [],
  herbivores: [],
  carnivores: [],
  rootLinks: [],
  deathEffects: [],
  salvageEffects: [],
  plantById: new Map(),
  bodyById: new Map(),
  nextPlantId: 1,
  nextBodyId: 1,
  nextAnimalId: 1,
  nextLinkId: 1,
  nextPacketId: 1,
  paused: false,
  lastFrameAt: 0,
  speedMultiplier: Number(speedInput.value),
  worldAge: 0,
  activeFeeds: [],
  spawners: {
    herbivore: { x: SPAWNER_DEFAULTS.herbivore.x, y: SPAWNER_DEFAULTS.herbivore.y, seatX: SPAWNER_DEFAULTS.herbivore.x, seatY: SPAWNER_DEFAULTS.herbivore.y, enabled: false, blockedByThicket: false, wasEnabled: false, nextSpawnIn: 0, visibleScale: 1, dragging: false },
    carnivore: { x: SPAWNER_DEFAULTS.carnivore.x, y: SPAWNER_DEFAULTS.carnivore.y, seatX: SPAWNER_DEFAULTS.carnivore.x, seatY: SPAWNER_DEFAULTS.carnivore.y, enabled: false, blockedByThicket: false, wasEnabled: false, nextSpawnIn: 0, visibleScale: 1, dragging: false },
    plant: { x: SPAWNER_DEFAULTS.plant.x, y: SPAWNER_DEFAULTS.plant.y, seatX: SPAWNER_DEFAULTS.plant.x, seatY: SPAWNER_DEFAULTS.plant.y, enabled: false, blockedByThicket: false, wasEnabled: false, nextSpawnIn: 0, visibleScale: 1, dragging: false },
  },
  draggedSpawnerKind: null,
  draggedPointerId: null,
};

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function chancePerSecond(rate, dt) {
  return Math.random() < rate * dt;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function updateSpawnerAnimations(dt) {
  const blend = 1 - Math.exp(-WORLD.spawnerOpenCloseSpeed * dt);
  for (const spawner of Object.values(state.spawners)) {
    const targetScale = 1;
    spawner.visibleScale += (targetScale - spawner.visibleScale) * blend;
    if (Math.abs(spawner.visibleScale - targetScale) < 0.001) {
      spawner.visibleScale = targetScale;
    }
  }
}

function normalizeAngle(angle) {
  let value = angle;
  while (value > Math.PI) {
    value -= Math.PI * 2;
  }
  while (value < -Math.PI) {
    value += Math.PI * 2;
  }
  return value;
}

function refreshEntityIndexes() {
  state.plantById = new Map(state.plants.map((plant) => [plant.id, plant]));
  state.bodyById = new Map(state.bodies.map((body) => [body.id, body]));
}

function getPlantById(id) {
  return state.plantById.get(id) ?? null;
}

function getBodyById(id) {
  return state.bodyById.get(id) ?? null;
}

function plantHealth(plant) {
  if (!plant) {
    return 0;
  }
  return clamp((plant.nutrients / plant.maxNutrients) * (1 - plant.wilt * 0.8), 0, 1);
}

function getInnerSpawnBounds() {
  const innerWidth = state.width * WORLD.innerSpawnAreaRatio;
  const innerHeight = state.height * WORLD.innerSpawnAreaRatio;
  return {
    left: (state.width - innerWidth) * 0.5,
    top: (state.height - innerHeight) * 0.5,
    right: (state.width + innerWidth) * 0.5,
    bottom: (state.height + innerHeight) * 0.5,
  };
}

function getThicketBounds() {
  return {
    left: WORLD.edgeThicketWidth,
    top: WORLD.edgeThicketWidth,
    right: state.width - WORLD.edgeThicketWidth,
    bottom: state.height - WORLD.edgeThicketWidth,
  };
}

function isPointInsideThicket(x, y) {
  const bounds = getThicketBounds();
  return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
}

function layoutSpawnerSeats() {
  const bounds = getThicketBounds();
  const seatX = Math.max(WORLD.spawnerDragRadius + 4, bounds.left * 0.5);
  const verticalSpace = Math.max(bounds.bottom - bounds.top, 1);
  const seatRatios = {
    plant: 0.28,
    herbivore: 0.5,
    carnivore: 0.72,
  };

  for (const kind of SPAWNER_KINDS) {
    const spawner = state.spawners[kind];
    spawner.seatX = seatX;
    spawner.seatY = bounds.top + verticalSpace * seatRatios[kind];

    if (!spawner.dragging) {
      spawner.x = spawner.seatX;
      spawner.y = spawner.seatY;
    }
  }
}

function snapSpawnerToSeat(kind) {
  const spawner = state.spawners[kind];
  spawner.x = spawner.seatX;
  spawner.y = spawner.seatY;
  spawner.enabled = false;
  spawner.blockedByThicket = false;
  spawner.dragging = false;
}

function resetSpawnersToSeats() {
  layoutSpawnerSeats();

  for (const kind of SPAWNER_KINDS) {
    const spawner = state.spawners[kind];
    spawner.wasEnabled = false;
    spawner.visibleScale = 1;
    spawner.nextSpawnIn = randomSpawnerInterval(kind);
    snapSpawnerToSeat(kind);
  }

  state.draggedSpawnerKind = null;
  state.draggedPointerId = null;
}

function applyThicketPressure(entity, dt) {
  const bounds = getThicketBounds();
  let pushX = 0;
  let pushY = 0;

  if (entity.x < bounds.left) {
    pushX += (bounds.left - entity.x) / Math.max(WORLD.edgeThicketWidth, 1);
  } else if (entity.x > bounds.right) {
    pushX -= (entity.x - bounds.right) / Math.max(WORLD.edgeThicketWidth, 1);
  }

  if (entity.y < bounds.top) {
    pushY += (bounds.top - entity.y) / Math.max(WORLD.edgeThicketWidth, 1);
  } else if (entity.y > bounds.bottom) {
    pushY -= (entity.y - bounds.bottom) / Math.max(WORLD.edgeThicketWidth, 1);
  }

  if (pushX === 0 && pushY === 0) {
    return;
  }

  entity.velocityX += pushX * WORLD.edgeThicketPushStrength * dt;
  entity.velocityY += pushY * WORLD.edgeThicketPushStrength * dt;
}

function steerOutOfThicket(entity, speedScale, dt, forceMultiplier = 1) {
  if (!isPointInsideThicket(entity.x, entity.y)) {
    return false;
  }

  const bounds = getThicketBounds();
  const targetX = clamp(entity.x, bounds.left + WORLD.animalMovementPadding, bounds.right - WORLD.animalMovementPadding);
  const targetY = clamp(entity.y, bounds.top + WORLD.animalMovementPadding, bounds.bottom - WORLD.animalMovementPadding);
  steerToward(entity, targetX, targetY, speedScale, dt, forceMultiplier);
  return true;
}

function isPlantWilting(plant) {
  return plant.nutrients <= 0.01 || plant.wilt > 0.01 || !plant.alive;
}

function getLinkEndpoints(link) {
  const source = getPlantById(link.sourcePlantId);
  const target = link.targetKind === "plant" ? getPlantById(link.targetId) : getBodyById(link.targetId);
  if (!source || !target) {
    return null;
  }
  return { source, target };
}

function getLinkBaseLength(link) {
  const endpoints = getLinkEndpoints(link);
  return endpoints ? distanceBetween(endpoints.source, endpoints.target) : 0;
}

function getLinkCurrentLength(link) {
  return getLinkBaseLength(link) * link.progress;
}

function getLinkTargetPoint(link) {
  const endpoints = getLinkEndpoints(link);
  if (!endpoints) {
    return null;
  }
  const { source, target } = endpoints;
  return {
    x: source.x + (target.x - source.x) * link.progress,
    y: source.y + (target.y - source.y) * link.progress,
  };
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  state.width = rect.width;
  state.height = rect.height;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutSpawnerSeats();
}

function createPlant(x, y, options = {}) {
  const maxNutrients = options.maxNutrients ?? randomInRange(WORLD.maxNutrientsMin, WORLD.maxNutrientsMax);
  const nutrients = clamp(
    options.nutrients ?? randomInRange(WORLD.initialNutrientsMin, WORLD.initialNutrientsMax),
    0,
    maxNutrients
  );

  return {
    id: state.nextPlantId++,
    x,
    y,
    nutrients,
    maxNutrients,
    intakeMultiplier: options.intakeMultiplier ?? randomInRange(WORLD.intakeMultiplierMin, WORLD.intakeMultiplierMax),
    proliferationThreshold: options.proliferationThreshold ?? randomInRange(WORLD.proliferateThresholdMin, WORLD.proliferateThresholdMax),
    upkeep: WORLD.baseUpkeep,
    wilt: nutrients <= 0 ? 1 : 0,
    alive: true,
    exhaustedFor: 0,
    bornAt: state.worldAge,
    preferredBodyId: null,
    beingEaten: false,
    exploratoryCooldown: randomInRange(0.5, 2.4),
    proliferationCooldown: 0,
  };
}

function createBody(x, y, nutrients) {
  return {
    id: state.nextBodyId++,
    x,
    y,
    nutrients,
    maxNutrients: nutrients,
  };
}

function createAnimal(kind, x, y, homeX, homeY, options = {}) {
  const isCarnivore = kind === "carnivore";
  const sizeScale = options.sizeScale ?? 1;
  const hungerMax = WORLD.animalHungerMax;
  return {
    id: state.nextAnimalId++,
    kind,
    x,
    y,
    homeX,
    homeY,
    facingAngle: Math.random() * Math.PI * 2,
    idleState: "standing",
    idleStateTimer: randomInRange(WORLD.idlePauseMinSeconds, WORLD.idlePauseMaxSeconds),
    idleTargetX: x,
    idleTargetY: y,
    grazingPlantId: null,
    isEating: false,
    currentSpeed: 0,
    velocityX: 0,
    velocityY: 0,
    pauseTimer: 0,
    chaseStarvationFor: 0,
    mateCooldown: options.mateCooldown ?? randomInRange(2, 5),
    mateTargetId: null,
    fightCooldown: randomInRange(2, 6),
    fightTargetId: null,
    fightTimer: 0,
    sizeScale,
    growthNutrients: options.growthNutrients ?? 0,
    growthNutrientsRequired: options.growthNutrientsRequired ?? 0,
    mature: sizeScale >= 1,
    speed: randomInRange(
      isCarnivore ? WORLD.carnivoreSpeedMin : WORLD.herbivoreSpeedMin,
      isCarnivore ? WORLD.carnivoreSpeedMax : WORLD.herbivoreSpeedMax
    ),
    hunger: randomInRange(WORLD.animalSpawnInitialHungerMinRatio, WORLD.animalSpawnInitialHungerMaxRatio) * hungerMax,
    hungerMax,
    hungerRate: randomInRange(
      isCarnivore ? WORLD.carnivoreHungerRateMinRatio : WORLD.herbivoreHungerRateMinRatio,
      isCarnivore ? WORLD.carnivoreHungerRateMaxRatio : WORLD.herbivoreHungerRateMaxRatio
    ) * hungerMax,
  };
}

function randomSpawnerInterval(kind) {
  if (kind === "carnivore") {
    return randomInRange(WORLD.carnivoreSpawnMinSeconds, WORLD.carnivoreSpawnMaxSeconds);
  }
  if (kind === "plant") {
    return randomInRange(WORLD.plantSpawnerMinSeconds, WORLD.plantSpawnerMaxSeconds);
  }
  return randomInRange(WORLD.herbivoreSpawnMinSeconds, WORLD.herbivoreSpawnMaxSeconds);
}

function randomInitialSpawnerInterval(kind) {
  if (kind === "plant") {
    return randomInRange(0.08, 0.28);
  }
  if (kind === "herbivore") {
    return randomInRange(0.35, 1.2);
  }
  return randomInRange(0.75, 2.2);
}

function getSpawnerSpawnPoint(spawner) {
  const angle = Math.random() * Math.PI * 2;
  const distance = randomInRange(10, 26);
  return {
    x: clamp(spawner.x + Math.cos(angle) * distance, WORLD.plantMargin, state.width - WORLD.plantMargin),
    y: clamp(spawner.y + Math.sin(angle) * distance, WORLD.plantMargin, state.height - WORLD.plantMargin),
  };
}

function clampAnimalPosition(entity) {
  entity.x = clamp(entity.x, WORLD.animalMovementPadding * 0.5, state.width - WORLD.animalMovementPadding * 0.5);
  entity.y = clamp(entity.y, WORLD.animalMovementPadding * 0.5, state.height - WORLD.animalMovementPadding * 0.5);
}

function steerToward(entity, targetX, targetY, speedScale, dt, forceMultiplier = 1) {
  const paddedTargetX = clamp(targetX, WORLD.animalMovementPadding, state.width - WORLD.animalMovementPadding);
  const paddedTargetY = clamp(targetY, WORLD.animalMovementPadding, state.height - WORLD.animalMovementPadding);
  const dx = paddedTargetX - entity.x;
  const dy = paddedTargetY - entity.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) {
    return 0;
  }

  const desiredAngle = Math.atan2(dy, dx);
  const angleDelta = normalizeAngle(desiredAngle - entity.facingAngle);
  const maxTurn = WORLD.animalTurnRate * dt;
  entity.facingAngle += clamp(angleDelta, -maxTurn, maxTurn);

  const force = entity.speed * speedScale * WORLD.animalAcceleration * 0.01 * forceMultiplier * dt;
  entity.velocityX += (dx / distance) * force;
  entity.velocityY += (dy / distance) * force;
  return distance;
}

function steerAway(entity, sourceX, sourceY, speedScale, dt, forceMultiplier = 1) {
  const dx = entity.x - sourceX;
  const dy = entity.y - sourceY;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) {
    return 0;
  }

  const desiredAngle = Math.atan2(dy, dx);
  const angleDelta = normalizeAngle(desiredAngle - entity.facingAngle);
  const maxTurn = WORLD.animalTurnRate * dt;
  entity.facingAngle += clamp(angleDelta, -maxTurn, maxTurn);

  const force = entity.speed * speedScale * WORLD.animalAcceleration * 0.01 * forceMultiplier * dt;
  entity.velocityX += (dx / distance) * force;
  entity.velocityY += (dy / distance) * force;
  return distance;
}

function moveToward(entity, targetX, targetY, speedScale, dt) {
  return steerToward(entity, targetX, targetY, speedScale, dt);
}

function slowAnimal(entity, dt) {
  const blend = 1 - Math.exp(-WORLD.animalDeceleration * 0.05 * dt);
  entity.velocityX += (0 - entity.velocityX) * blend;
  entity.velocityY += (0 - entity.velocityY) * blend;
  entity.currentSpeed = Math.hypot(entity.velocityX, entity.velocityY);
}

function stopAnimal(entity) {
  entity.currentSpeed = 0;
  entity.velocityX = 0;
  entity.velocityY = 0;
}

function applyAnimalMotion(entity, dt) {
  const drag = Math.exp(-WORLD.animalMotionDrag * dt);
  entity.velocityX *= drag;
  entity.velocityY *= drag;

  const speed = Math.hypot(entity.velocityX, entity.velocityY);
  const maxSpeed = entity.speed * WORLD.animalTopSpeedFactor;
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    entity.velocityX *= scale;
    entity.velocityY *= scale;
  }

  entity.currentSpeed = Math.hypot(entity.velocityX, entity.velocityY);
  entity.x += entity.velocityX * dt;
  entity.y += entity.velocityY * dt;
  applyThicketPressure(entity, dt);
  entity.x += entity.velocityX * dt * 0.18;
  entity.y += entity.velocityY * dt * 0.18;
  clampAnimalPosition(entity);

  if (entity.currentSpeed > 0.25) {
    const desiredAngle = Math.atan2(entity.velocityY, entity.velocityX);
    const maxTurn = WORLD.animalTurnRate * dt;
    const angleDelta = normalizeAngle(desiredAngle - entity.facingAngle);
    entity.facingAngle += clamp(angleDelta, -maxTurn, maxTurn);
  }
}

function chooseIdleTargetNearHome(entity, radius) {
  const angle = Math.random() * Math.PI * 2;
  const distance = randomInRange(8, radius);
  return {
    x: entity.homeX + Math.cos(angle) * distance,
    y: entity.homeY + Math.sin(angle) * distance,
  };
}

function chooseIdleState(entity, radius) {
  const roll = Math.random();

  if (roll < WORLD.idleStandChance) {
    entity.idleState = "standing";
    entity.idleStateTimer = randomInRange(WORLD.idlePauseMinSeconds, WORLD.idlePauseMaxSeconds);
    entity.idleTargetX = entity.x;
    entity.idleTargetY = entity.y;
    return;
  }

  if (roll < WORLD.idleStandChance + WORLD.idleReturnHomeChance) {
    entity.idleState = "walking_home";
    entity.idleStateTimer = randomInRange(WORLD.idleWalkMinSeconds, WORLD.idleWalkMaxSeconds);
    entity.idleTargetX = entity.homeX;
    entity.idleTargetY = entity.homeY;
    return;
  }

  entity.idleState = "roaming";
  entity.idleStateTimer = randomInRange(WORLD.idleWalkMinSeconds, WORLD.idleWalkMaxSeconds);
  const target = chooseIdleTargetNearHome(entity, radius);
  entity.idleTargetX = target.x;
  entity.idleTargetY = target.y;
}

function updateIdleBehavior(entity, radius, speedScale, dt) {
  entity.idleStateTimer -= dt;
  if (entity.idleStateTimer <= 0) {
    chooseIdleState(entity, radius);
  }

  if (entity.idleState === "standing") {
    slowAnimal(entity, dt);
    return;
  }

  if (entity.idleState === "walking_home") {
    const distanceToHome = moveToward(entity, entity.homeX, entity.homeY, speedScale, dt);
    if (distanceToHome <= WORLD.idleArrivalDistance) {
      chooseIdleState(entity, radius);
    }
    return;
  }

  const distanceToIdleTarget = moveToward(entity, entity.idleTargetX, entity.idleTargetY, speedScale, dt);
  if (distanceToIdleTarget <= WORLD.idleArrivalDistance) {
    chooseIdleState(entity, radius);
  }
}

function isCarnivoreHunting(carnivore) {
  if (carnivore.pauseTimer > 0) {
    return false;
  }

  const hungry = carnivore.hunger >= carnivore.hungerMax * 0.5;
  if (!hungry) {
    return false;
  }

  return state.herbivores.some((herbivore) => {
    if (!herbivore.mature) {
      return false;
    }
    return distanceBetween(carnivore, herbivore) <= WORLD.carnivoreSenseRange;
  });
}

function findClosestThreat(herbivore, huntingCarnivores = null) {
  let closest = null;
  let closestDistance = Infinity;
  const carnivores = huntingCarnivores ?? state.carnivores.filter((carnivore) => isCarnivoreHunting(carnivore));
  for (const carnivore of carnivores) {
    const distance = distanceBetween(herbivore, carnivore);
    if (distance < WORLD.herbivoreThreatRange && distance < closestDistance) {
      closest = carnivore;
      closestDistance = distance;
    }
  }
  return closest ? { carnivore: closest, distance: closestDistance } : null;
}

function dropBodyAt(x, y, nutrients) {
  const body = createBody(x, y, nutrients);
  state.bodies.push(body);
  state.bodyById.set(body.id, body);
}

function addDeathEffect(animal) {
  state.deathEffects.push({
    x: animal.x,
    y: animal.y,
    kind: animal.kind,
    sizeScale: animal.sizeScale,
    age: 0,
    duration: 0.72,
    angle: animal.facingAngle,
  });
}

function createRootLink(sourcePlantId, targetKind, targetId, type) {
  const source = getPlantById(sourcePlantId);
  if (!source) {
    return null;
  }

  const health = plantHealth(source);
  const growthDuration = type === "explore"
    ? lerp(WORLD.exploratoryRootMaxGrowthSeconds, WORLD.exploratoryRootMinGrowthSeconds, health)
    : lerp(WORLD.supportRootMaxGrowthSeconds, WORLD.supportRootMinGrowthSeconds, health);

  const link = {
    id: state.nextLinkId++,
    key: type === "support"
      ? `support:${Math.min(sourcePlantId, targetId)}-${Math.max(sourcePlantId, targetId)}`
      : `explore:${sourcePlantId}->${targetId}`,
    type,
    sourcePlantId,
    targetKind,
    targetId,
    progress: 0,
    desired: true,
    retracting: false,
    growthDuration,
    retractDuration: type === "explore" ? WORLD.exploratoryRootRetractSeconds : WORLD.supportRootRetractSeconds,
    packets: [],
    packetCooldown: randomInRange(0.15, 1.1),
  };

  state.rootLinks.push(link);
  return link;
}

function bodyVisualRadius(body) {
  const ratio = clamp(body.nutrients / Math.max(body.maxNutrients, 0.001), 0, 1);
  return 0.45 + Math.pow(ratio, 0.65) * 2.9;
}

function plantVisualRadius(plant) {
  const ratio = clamp(plant.nutrients / plant.maxNutrients, 0, 1);
  const base = 2.8 + ratio * 9.2;
  return base * (1 - plant.wilt * 0.35);
}

function clampPlantPosition(plant) {
  plant.x = clamp(plant.x, WORLD.plantMargin, state.width - WORLD.plantMargin);
  plant.y = clamp(plant.y, WORLD.plantMargin, state.height - WORLD.plantMargin);
}

function getAnimalPhysicalRadius(animal) {
  const baseRadius = animal.kind === "carnivore" ? WORLD.carnivorePhysicalRadius : WORLD.herbivorePhysicalRadius;
  return baseRadius * animal.sizeScale;
}

function animalNourishmentRatio(animal) {
  return 1 - animal.hunger / animal.hungerMax;
}

function shouldAnimalDieFromHunger(animal, inChase, dt) {
  if (animal.hunger < animal.hungerMax) {
    animal.chaseStarvationFor = 0;
    return false;
  }

  animal.hunger = animal.hungerMax;
  if (!inChase) {
    return true;
  }

  animal.chaseStarvationFor += dt;
  return animal.chaseStarvationFor >= WORLD.animalChaseStarvationGraceSeconds;
}

function getAnimalMateConfig(kind) {
  return kind === "carnivore"
    ? {
      nourishmentRatio: WORLD.carnivoreMateNourishmentRatio,
      searchRange: WORLD.carnivoreMateSearchRange,
      contactDistance: WORLD.carnivoreMateContactDistance,
      chancePerSecond: WORLD.carnivoreMateChancePerSecond,
      hungerCostRatio: WORLD.carnivoreMateHungerCostRatio,
      cooldownSeconds: WORLD.carnivoreMateCooldownSeconds,
      babyScale: WORLD.carnivoreBabyScale,
      babyGrowthNutrients: WORLD.carnivoreBabyGrowthNutrients,
    }
    : {
      nourishmentRatio: WORLD.herbivoreMateNourishmentRatio,
      searchRange: WORLD.herbivoreMateSearchRange,
      contactDistance: WORLD.herbivoreMateContactDistance,
      chancePerSecond: WORLD.herbivoreMateChancePerSecond,
      hungerCostRatio: WORLD.herbivoreMateHungerCostRatio,
      cooldownSeconds: WORLD.herbivoreMateCooldownSeconds,
      babyScale: WORLD.herbivoreBabyScale,
      babyGrowthNutrients: WORLD.herbivoreBabyGrowthNutrients,
    };
}

function canSeekMate(animal) {
  const config = getAnimalMateConfig(animal.kind);
  return animal.mature
    && animal.mateCooldown <= 0
    && animalNourishmentRatio(animal) >= config.nourishmentRatio
    && animal.hunger + config.hungerCostRatio * animal.hungerMax < animal.hungerMax;
}

function addAnimalGrowthNutrients(animal, nutrients) {
  if (animal.mature || animal.growthNutrientsRequired <= 0) {
    return;
  }

  animal.growthNutrients += nutrients;
  const progress = clamp(animal.growthNutrients / animal.growthNutrientsRequired, 0, 1);
  const babyScale = animal.kind === "carnivore" ? WORLD.carnivoreBabyScale : WORLD.herbivoreBabyScale;
  animal.sizeScale = lerp(babyScale, 1, progress);
  if (progress >= 1) {
    animal.sizeScale = 1;
    animal.mature = true;
    animal.mateCooldown = Math.max(animal.mateCooldown, getAnimalMateConfig(animal.kind).cooldownSeconds * 0.5);
  }
}

function findMateTarget(animal, animals) {
  const config = getAnimalMateConfig(animal.kind);
  let closest = null;
  let closestDistance = Infinity;

  for (const candidate of animals) {
    if (candidate.id === animal.id || !canSeekMate(candidate)) {
      continue;
    }

    const distance = distanceBetween(animal, candidate);
    if (distance <= config.searchRange && distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return closest ? { animal: closest, distance: closestDistance } : null;
}

function tryAnimalMating(animal, animals, newborns, dt) {
  if (!canSeekMate(animal)) {
    animal.mateTargetId = null;
    return false;
  }

  let mateTarget = animal.mateTargetId
    ? animals.find((candidate) => candidate.id === animal.mateTargetId && canSeekMate(candidate)) ?? null
    : null;
  let mateDistance = mateTarget ? distanceBetween(animal, mateTarget) : Infinity;
  const config = getAnimalMateConfig(animal.kind);

  if (!mateTarget || mateDistance > config.searchRange) {
    const nextTarget = findMateTarget(animal, animals);
    if (!nextTarget) {
      animal.mateTargetId = null;
      return false;
    }
    mateTarget = nextTarget.animal;
    mateDistance = nextTarget.distance;
    animal.mateTargetId = mateTarget.id;
  }

  if (mateDistance > config.contactDistance) {
    moveToward(animal, mateTarget.x, mateTarget.y, 0.82, dt);
    return true;
  }

  stopAnimal(animal);
  if (animal.id > mateTarget.id || !chancePerSecond(config.chancePerSecond, dt)) {
    return true;
  }

  const babyX = (animal.x + mateTarget.x) * 0.5 + randomInRange(-4, 4);
  const babyY = (animal.y + mateTarget.y) * 0.5 + randomInRange(-4, 4);
  const baby = createAnimal(animal.kind, babyX, babyY, animal.homeX, animal.homeY, {
    sizeScale: config.babyScale,
    growthNutrients: 0,
    growthNutrientsRequired: config.babyGrowthNutrients,
    mateCooldown: config.cooldownSeconds,
  });

  animal.hunger = clamp(animal.hunger + config.hungerCostRatio * animal.hungerMax, 0, animal.hungerMax);
  mateTarget.hunger = clamp(mateTarget.hunger + config.hungerCostRatio * mateTarget.hungerMax, 0, mateTarget.hungerMax);
  animal.mateCooldown = config.cooldownSeconds;
  mateTarget.mateCooldown = config.cooldownSeconds;
  animal.mateTargetId = null;
  mateTarget.mateTargetId = null;
  newborns.push(baby);
  return true;
}

function findCarnivoreFightTarget(carnivore, killedCarnivoreIds) {
  let closest = null;
  let closestDistance = Infinity;

  for (const candidate of state.carnivores) {
    if (
      candidate.id === carnivore.id
      || killedCarnivoreIds.has(candidate.id)
      || candidate.fightCooldown > 0
      || candidate.pauseTimer > 0
    ) {
      continue;
    }

    const distance = distanceBetween(carnivore, candidate);
    if (distance <= WORLD.carnivoreFightSearchRange && distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return closest ? { carnivore: closest, distance: closestDistance } : null;
}

function resolveCarnivoreFight(attacker, defender, killedCarnivoreIds) {
  const attackerScore = animalNourishmentRatio(attacker) + attacker.sizeScale * 0.65 + Math.random() * 0.55;
  const defenderScore = animalNourishmentRatio(defender) + defender.sizeScale * 0.65 + Math.random() * 0.55;
  const winner = attackerScore >= defenderScore ? attacker : defender;
  const loser = winner === attacker ? defender : attacker;

  addDeathEffect(loser);
  dropBodyAt(loser.x, loser.y, WORLD.carnivoreCorpseNutrients);
  killedCarnivoreIds.add(loser.id);

  winner.fightCooldown = WORLD.carnivoreFightCooldownSeconds;
  winner.fightTargetId = null;
  winner.fightTimer = 0;
  winner.mateTargetId = null;
  winner.pauseTimer = Math.max(winner.pauseTimer, WORLD.carnivorePostKillPauseSeconds);
  loser.fightTargetId = null;
  loser.fightTimer = 0;
  stopAnimal(winner);
}

function tryCarnivoreFight(carnivore, killedCarnivoreIds, dt) {
  if (
    state.carnivores.length <= WORLD.carnivoreFightPopulationThreshold
    || killedCarnivoreIds.has(carnivore.id)
    || carnivore.pauseTimer > 0
    || carnivore.fightCooldown > 0
  ) {
    carnivore.fightTargetId = null;
    carnivore.fightTimer = 0;
    return false;
  }

  let target = carnivore.fightTargetId
    ? state.carnivores.find((candidate) => {
      return candidate.id === carnivore.fightTargetId
        && !killedCarnivoreIds.has(candidate.id)
        && candidate.fightCooldown <= 0;
    }) ?? null
    : null;
  let distance = target ? distanceBetween(carnivore, target) : Infinity;

  if (!target || distance > WORLD.carnivoreFightSearchRange) {
    carnivore.fightTimer = 0;
    if (!chancePerSecond(WORLD.carnivoreFightChancePerSecond, dt)) {
      carnivore.fightTargetId = null;
      return false;
    }

    const nextTarget = findCarnivoreFightTarget(carnivore, killedCarnivoreIds);
    if (!nextTarget) {
      carnivore.fightTargetId = null;
      return false;
    }

    target = nextTarget.carnivore;
    distance = nextTarget.distance;
    carnivore.fightTargetId = target.id;
    target.fightTargetId = carnivore.id;
    carnivore.mateTargetId = null;
    target.mateTargetId = null;
  }

  if (distance > WORLD.carnivoreFightContactDistance) {
    carnivore.fightTimer = 0;
    steerToward(carnivore, target.x, target.y, 1.05, dt, 1.7);
    return true;
  }

  const angle = Math.atan2(target.y - carnivore.y, target.x - carnivore.x) + Math.PI * 0.5;
  const jitter = Math.sin(state.worldAge * 24 + carnivore.id) * 0.7;
  steerToward(
    carnivore,
    target.x + Math.cos(angle) * jitter,
    target.y + Math.sin(angle) * jitter,
    0.72,
    dt,
    1.4
  );

  if (carnivore.id > target.id) {
    return true;
  }

  carnivore.fightTimer += dt;
  target.fightTimer = Math.max(target.fightTimer, carnivore.fightTimer);

  if (carnivore.fightTimer < WORLD.carnivoreFightDurationSeconds) {
    return true;
  }

  resolveCarnivoreFight(carnivore, target, killedCarnivoreIds);
  return true;
}

function getGridKey(x, y, cellSize) {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
}

function buildSpatialGrid(items, cellSize, includeItem = null) {
  const cells = new Map();

  for (const item of items) {
    if (includeItem && !includeItem(item)) {
      continue;
    }

    const key = getGridKey(item.x, item.y, cellSize);
    const bucket = cells.get(key) ?? [];
    bucket.push(item);
    cells.set(key, bucket);
  }

  return { cells, cellSize };
}

function forEachNearby(grid, x, y, radius, callback) {
  const cellRadius = Math.ceil(radius / grid.cellSize);
  const centerCellX = Math.floor(x / grid.cellSize);
  const centerCellY = Math.floor(y / grid.cellSize);

  for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX += 1) {
    for (let offsetY = -cellRadius; offsetY <= cellRadius; offsetY += 1) {
      const bucket = grid.cells.get(`${centerCellX + offsetX},${centerCellY + offsetY}`);
      if (!bucket) {
        continue;
      }

      for (const item of bucket) {
        callback(item);
      }
    }
  }
}

function resolvePlantPlantOverlaps() {
  const cellSize = WORLD.plantPhysicalRadius * 2.5;
  const grid = new Map();

  for (let i = 0; i < state.plants.length; i += 1) {
    const plant = state.plants[i];
    if (!plant.alive) {
      continue;
    }

    const key = getGridKey(plant.x, plant.y, cellSize);
    const bucket = grid.get(key) ?? [];
    bucket.push(i);
    grid.set(key, bucket);
  }

  const checkedPairs = new Set();
  for (const [key, plantIndexes] of grid) {
    const [cellX, cellY] = key.split(",").map(Number);
    const neighborIndexes = [...plantIndexes];

    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }
        const neighborBucket = grid.get(`${cellX + offsetX},${cellY + offsetY}`);
        if (neighborBucket) {
          neighborIndexes.push(...neighborBucket);
        }
      }
    }

    for (const i of plantIndexes) {
      const a = state.plants[i];
      for (const j of neighborIndexes) {
        if (j <= i) {
          continue;
        }

        const pairKey = `${i}:${j}`;
        if (checkedPairs.has(pairKey)) {
          continue;
        }
        checkedPairs.add(pairKey);

        const b = state.plants[j];
        if (!b.alive) {
          continue;
        }

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.0001;
        const minDistance = WORLD.plantPhysicalRadius * 2;
        if (distance >= minDistance) {
          continue;
        }

        const overlap = (minDistance - distance) * 0.5;
        const nx = dx / distance;
        const ny = dy / distance;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        clampPlantPosition(a);
        clampPlantPosition(b);
      }
    }
  }
}

function resolveAnimalAnimalOverlaps() {
  const animals = [...state.herbivores, ...state.carnivores];
  const maxAnimalRadius = Math.max(WORLD.herbivorePhysicalRadius, WORLD.carnivorePhysicalRadius);
  const animalGrid = buildSpatialGrid(animals, Math.max(maxAnimalRadius * 2, 1));
  const checkedPairs = new Set();

  for (const a of animals) {
    const searchRadius = getAnimalPhysicalRadius(a) + maxAnimalRadius;
    forEachNearby(animalGrid, a.x, a.y, searchRadius, (b) => {
      if (a.id === b.id) {
        return;
      }

      const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (checkedPairs.has(pairKey)) {
        return;
      }
      checkedPairs.add(pairKey);

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.0001;
      const minDistance = getAnimalPhysicalRadius(a) + getAnimalPhysicalRadius(b);
      if (distance >= minDistance) {
        return;
      }

      const overlap = (minDistance - distance) * 0.5;
      const nx = dx / distance;
      const ny = dy / distance;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;
      a.x = clamp(a.x, WORLD.animalMovementPadding * 0.5, state.width - WORLD.animalMovementPadding * 0.5);
      a.y = clamp(a.y, WORLD.animalMovementPadding * 0.5, state.height - WORLD.animalMovementPadding * 0.5);
      b.x = clamp(b.x, WORLD.animalMovementPadding * 0.5, state.width - WORLD.animalMovementPadding * 0.5);
      b.y = clamp(b.y, WORLD.animalMovementPadding * 0.5, state.height - WORLD.animalMovementPadding * 0.5);
    });
  }
}

function resolveCarnivorePlantInteractions() {
  if (state.carnivores.length === 0 || state.plants.length === 0) {
    return;
  }

  const maxInteractionDistance = WORLD.carnivorePhysicalRadius + WORLD.plantPhysicalRadius;
  const plantGrid = buildSpatialGrid(
    state.plants,
    Math.max(maxInteractionDistance, 1),
    (plant) => plant.alive
  );

  for (const carnivore of state.carnivores) {
    const minDistance = getAnimalPhysicalRadius(carnivore) + WORLD.plantPhysicalRadius;
    forEachNearby(plantGrid, carnivore.x, carnivore.y, minDistance, (plant) => {
      const dx = plant.x - carnivore.x;
      const dy = plant.y - carnivore.y;
      const distance = Math.hypot(dx, dy) || 0.0001;
      if (distance >= minDistance) {
        return;
      }

      const overlap = minDistance - distance;
      const nx = dx / distance;
      const ny = dy / distance;
      const push = overlap * WORLD.carnivorePlantBrushStrength;
      plant.x += nx * push;
      plant.y += ny * push;
      carnivore.x -= nx * push * WORLD.carnivorePlantSelfPushStrength;
      carnivore.y -= ny * push * WORLD.carnivorePlantSelfPushStrength;
      carnivore.velocityX *= WORLD.carnivorePlantVelocityDamping;
      carnivore.velocityY *= WORLD.carnivorePlantVelocityDamping;
      clampPlantPosition(plant);
      carnivore.x = clamp(carnivore.x, WORLD.animalMovementPadding * 0.5, state.width - WORLD.animalMovementPadding * 0.5);
      carnivore.y = clamp(carnivore.y, WORLD.animalMovementPadding * 0.5, state.height - WORLD.animalMovementPadding * 0.5);
    });
  }
}

function resolvePhysicalInteractions() {
  resolveAnimalAnimalOverlaps();
  resolveCarnivorePlantInteractions();
  resolvePlantPlantOverlaps();
}

function resolvePredationContacts() {
  if (state.carnivores.length === 0 || state.herbivores.length === 0) {
    return;
  }

  const maxContactDistance = WORLD.carnivorePhysicalRadius + WORLD.herbivorePhysicalRadius;
  const herbivoreGrid = buildSpatialGrid(state.herbivores, Math.max(maxContactDistance, 1));
  const eatenHerbivoreIds = new Set();

  for (const carnivore of state.carnivores) {
    const hungry = carnivore.hunger >= carnivore.hungerMax * 0.5;
    if (!hungry) {
      continue;
    }

    let ate = false;
    const contactDistance = getAnimalPhysicalRadius(carnivore) + WORLD.herbivorePhysicalRadius;
    forEachNearby(herbivoreGrid, carnivore.x, carnivore.y, contactDistance, (herbivore) => {
      if (ate) {
        return;
      }
      if (!herbivore.mature || eatenHerbivoreIds.has(herbivore.id)) {
        return;
      }

      const distance = distanceBetween(carnivore, herbivore);
      const actualContactDistance = getAnimalPhysicalRadius(carnivore) + getAnimalPhysicalRadius(herbivore);
      if (distance > actualContactDistance) {
        return;
      }

      addDeathEffect(herbivore);
      eatenHerbivoreIds.add(herbivore.id);
      ate = true;
      carnivore.pauseTimer = WORLD.carnivorePostKillPauseSeconds;
      dropBodyAt(
        herbivore.x,
        herbivore.y,
        WORLD.herbivoreCorpseNutrients * WORLD.herbivoreEatenCorpseFraction
      );
      const killRelief = WORLD.carnivoreKillHungerReliefRatio * carnivore.hungerMax;
      carnivore.hunger = Math.max(0, carnivore.hunger - killRelief);
      addAnimalGrowthNutrients(carnivore, killRelief);
    });
  }

  if (eatenHerbivoreIds.size > 0) {
    state.herbivores = state.herbivores.filter((herbivore) => !eatenHerbivoreIds.has(herbivore.id));
  }
}

function randomPointInRect(left, top, right, bottom, margin = 0) {
  return {
    x: randomInRange(left + margin, Math.max(left + margin, right - margin)),
    y: randomInRange(top + margin, Math.max(top + margin, bottom - margin)),
  };
}

function randomInnerPoint(margin) {
  const bounds = getInnerSpawnBounds();
  return randomPointInRect(bounds.left, bounds.top, bounds.right, bounds.bottom, margin);
}

function randomizeSpawnerPosition(kind) {
  const spawner = state.spawners[kind];
  const point = randomInnerPoint(WORLD.animalMovementPadding);
  spawner.x = point.x;
  spawner.y = point.y;
}

function recenterAnimalsToInnerSpawnHome(animals) {
  const fallbackHome = randomInnerPoint(WORLD.animalMovementPadding);

  for (const animal of animals) {
    animal.homeX = fallbackHome.x;
    animal.homeY = fallbackHome.y;

    if (animal.idleState === "walking_home") {
      animal.idleTargetX = fallbackHome.x;
      animal.idleTargetY = fallbackHome.y;
    }
  }
}

function isFarFromPlants(point, minDistance = 18) {
  for (const plant of state.plants) {
    if (distanceBetween(point, plant) < minDistance) {
      return false;
    }
  }
  return true;
}

function spawnInitialWorld() {
  state.plants = [];
  state.bodies = [];
  state.herbivores = [];
  state.carnivores = [];
  state.rootLinks = [];
  state.deathEffects = [];
  state.salvageEffects = [];
  state.plantById = new Map();
  state.bodyById = new Map();
  state.nextPlantId = 1;
  state.nextBodyId = 1;
  state.nextAnimalId = 1;
  state.nextLinkId = 1;
  state.nextPacketId = 1;
  state.worldAge = 0;
  resetSpawnersToSeats();

  for (let i = 0; i < WORLD.initialHerbivores; i += 1) {
    const point = getSpawnerSpawnPoint(state.spawners.herbivore);
    state.herbivores.push(createAnimal("herbivore", point.x, point.y, state.spawners.herbivore.x, state.spawners.herbivore.y));
  }

  for (let i = 0; i < WORLD.initialCarnivores; i += 1) {
    const point = getSpawnerSpawnPoint(state.spawners.carnivore);
    state.carnivores.push(createAnimal("carnivore", point.x, point.y, state.spawners.carnivore.x, state.spawners.carnivore.y));
  }
}

function updateBodies(dt) {
  for (const body of state.bodies) {
    body.nutrients = Math.max(0, body.nutrients - WORLD.bodyNaturalDecay * dt);
  }
}

function updateDeathEffects(dt) {
  for (const effect of state.deathEffects) {
    effect.age += dt;
  }

  state.deathEffects = state.deathEffects.filter((effect) => effect.age < effect.duration);
}

function updateSalvageEffects(dt) {
  for (const effect of state.salvageEffects) {
    effect.age += dt;
  }

  state.salvageEffects = state.salvageEffects.filter((effect) => effect.age < effect.duration);
}

function updatePlantFeeding(dt) {
  const requestsByBody = new Map();
  state.activeFeeds = [];
  const bodyGrid = buildSpatialGrid(
    state.bodies,
    WORLD.feedingRange,
    (body) => body.nutrients > WORLD.bodyRemovalThreshold
  );

  for (const plant of state.plants) {
    if (!plant.alive || plant.beingEaten) {
      plant.preferredBodyId = null;
      continue;
    }

    let preferredTarget = null;
    let richestTarget = null;
    let richestNutrients = -Infinity;

    forEachNearby(bodyGrid, plant.x, plant.y, WORLD.feedingRange, (body) => {
      const distance = distanceBetween(plant, body);
      if (distance > WORLD.feedingRange) {
        return;
      }

      if (body.id === plant.preferredBodyId) {
        preferredTarget = body;
      }

      if (body.nutrients > richestNutrients) {
        richestTarget = body;
        richestNutrients = body.nutrients;
      }
    });

    const target = preferredTarget ?? richestTarget;
    if (!target) {
      plant.preferredBodyId = null;
      continue;
    }

    plant.preferredBodyId = target.id;

    const draw = WORLD.baseBodyFeedRate * plant.intakeMultiplier * dt;
    const requests = requestsByBody.get(target.id) ?? [];
    requests.push({ plant, draw });
    requestsByBody.set(target.id, requests);
  }

  for (const body of state.bodies) {
    const requests = requestsByBody.get(body.id);
    if (!requests || body.nutrients <= 0) {
      continue;
    }

    const totalRequested = requests.reduce((sum, request) => sum + request.draw, 0);
    const scale = Math.min(1, body.nutrients / Math.max(totalRequested, 0.0001));

    for (const request of requests) {
      const amount = request.draw * scale;
      request.plant.nutrients = clamp(request.plant.nutrients + amount, 0, request.plant.maxNutrients);
      body.nutrients = Math.max(0, body.nutrients - amount);
      state.activeFeeds.push({ plantId: request.plant.id, bodyId: body.id, amount });
    }
  }
}

function updatePlantUpkeep(dt) {
  const plantById = new Map(state.plants.map((plant) => [plant.id, plant]));
  const supportNeighborCounts = new Map();

  for (const link of state.rootLinks) {
    if (link.type !== "support" || link.progress < 0.7 || link.targetKind !== "plant") {
      continue;
    }

    const source = plantById.get(link.sourcePlantId);
    const target = plantById.get(link.targetId);
    if (!source?.alive || !target?.alive) {
      continue;
    }

    supportNeighborCounts.set(source.id, (supportNeighborCounts.get(source.id) ?? 0) + 1);
    supportNeighborCounts.set(target.id, (supportNeighborCounts.get(target.id) ?? 0) + 1);
  }

  for (const plant of state.plants) {
    plant.beingEaten = false;
    const connectedNeighbors = supportNeighborCounts.get(plant.id) ?? 0;
    const upkeepDiscount = connectedNeighbors * WORLD.neighborUpkeepDiscount;
    const effectiveUpkeep = Math.max(
      plant.upkeep * WORLD.minimumUpkeepRatio,
      plant.upkeep - upkeepDiscount
    );
    plant.nutrients = Math.max(0, plant.nutrients - effectiveUpkeep * dt);

    if (plant.nutrients <= 0) {
      plant.exhaustedFor += dt;
      plant.wilt = clamp(plant.wilt + WORLD.wiltFadeRate * dt, 0, 1);
    } else if (plant.alive && plant.nutrients >= WORLD.wiltRecoveryNutrients) {
      plant.exhaustedFor = 0;
      plant.wilt = clamp(plant.wilt - WORLD.wiltFadeRate * 1.5 * dt, 0, 1);
    } else if (plant.nutrients > 0) {
      plant.exhaustedFor = 0;
    }

    if (plant.alive && plant.wilt >= 0.999 && plant.exhaustedFor >= WORLD.starvationDeathSeconds) {
      plant.alive = false;
    }

    plant.exploratoryCooldown = Math.max(0, plant.exploratoryCooldown - dt);
    plant.proliferationCooldown = Math.max(0, plant.proliferationCooldown - dt);
  }
}

function getSupportLinkKey(aId, bId) {
  return `support:${Math.min(aId, bId)}-${Math.max(aId, bId)}`;
}

function markDesiredSupportLinks() {
  const supportLinks = state.rootLinks.filter((link) => link.type === "support");
  const supportLinkByKey = new Map(supportLinks.map((link) => [link.key, link]));
  for (const link of supportLinks) {
    link.desired = false;
  }

  const alivePlants = state.plants.filter((plant) => plant.alive && plant.wilt < 0.9);
  const grid = new Map();
  const cellSize = WORLD.networkRadius;
  const desiredKeys = new Set();

  for (const plant of alivePlants) {
    const key = getGridKey(plant.x, plant.y, cellSize);
    const bucket = grid.get(key) ?? [];
    bucket.push(plant);
    grid.set(key, bucket);
  }

  for (const plant of alivePlants) {
    const cellX = Math.floor(plant.x / cellSize);
    const cellY = Math.floor(plant.y / cellSize);
    const candidates = [];

    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const bucket = grid.get(`${cellX + offsetX},${cellY + offsetY}`);
        if (bucket) {
          candidates.push(...bucket);
        }
      }
    }

    const neighbors = candidates
      .filter((other) => other.id !== plant.id)
      .map((other) => ({
        other,
        distance: distanceBetween(plant, other),
      }))
      .filter(({ distance }) => distance <= WORLD.networkRadius)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, WORLD.supportNeighborsPerPlant);

    for (const neighbor of neighbors) {
      desiredKeys.add(getSupportLinkKey(plant.id, neighbor.other.id));
    }
  }

  for (const key of desiredKeys) {
    let link = supportLinkByKey.get(key);
    if (!link) {
      const [ids] = key.split(":").slice(1);
      const [aId, bId] = ids.split("-").map(Number);
      link = createRootLink(aId, "plant", bId, "support");
      if (link) {
        supportLinkByKey.set(key, link);
      }
    }
    if (link) {
      link.desired = true;
      link.retracting = false;
    }
  }
}

function buildPlantNetworkComponents() {
  const alivePlants = state.plants.filter((plant) => plant.alive);
  const visited = new Set();
  const components = [];
  const adjacency = new Map();

  for (const plant of alivePlants) {
    adjacency.set(plant.id, []);
  }

  for (const link of state.rootLinks) {
    if (link.type !== "support" || link.progress < 0.7 || link.retracting || link.targetKind !== "plant") {
      continue;
    }

    const a = getPlantById(link.sourcePlantId);
    const b = getPlantById(link.targetId);
    if (!a || !b || !a.alive || !b.alive) {
      continue;
    }

    adjacency.get(a.id)?.push(b.id);
    adjacency.get(b.id)?.push(a.id);
  }

  for (const plant of alivePlants) {
    if (visited.has(plant.id)) {
      continue;
    }

    const stack = [plant.id];
    const componentPlantIds = [];
    visited.add(plant.id);

    while (stack.length > 0) {
      const currentId = stack.pop();
      componentPlantIds.push(currentId);

      for (const neighborId of adjacency.get(currentId) ?? []) {
        if (visited.has(neighborId)) {
          continue;
        }
        visited.add(neighborId);
        stack.push(neighborId);
      }
    }

    components.push(componentPlantIds);
  }

  return components;
}

function buildFrontierOwnership() {
  const ownershipByPlantId = new Map();
  const components = buildPlantNetworkComponents();
  const maxOwnershipDistance = Math.max(WORLD.bridgeSearchRadius, WORLD.exploratoryBodyDistanceMax);
  const bodyGrid = buildSpatialGrid(
    state.bodies,
    Math.max(WORLD.feedingRange, 1),
    (body) => body.nutrients > 2
  );

  for (const componentPlantIds of components) {
    const componentPlants = componentPlantIds
      .map((plantId) => getPlantById(plantId))
      .filter(Boolean);
    const ownerByBodyId = new Map();

    for (const plant of componentPlants) {
      forEachNearby(bodyGrid, plant.x, plant.y, maxOwnershipDistance, (body) => {
        const distance = distanceBetween(plant, body);
        if (distance > maxOwnershipDistance) {
          return;
        }

        const owner = ownerByBodyId.get(body.id);
        if (!owner || distance < owner.distance) {
          ownerByBodyId.set(body.id, { plant, body, distance });
        }
      });
    }

    for (const owner of ownerByBodyId.values()) {
      const ownedBodies = ownershipByPlantId.get(owner.plant.id) ?? [];
      ownedBodies.push({ body: owner.body, distance: owner.distance });
      ownershipByPlantId.set(owner.plant.id, ownedBodies);
    }
  }

  return ownershipByPlantId;
}

function updateExploratoryRoots(frontierOwnership) {
  const explorationLinks = state.rootLinks.filter((link) => link.type === "explore");
  const explorationLinksBySource = new Map();

  for (const link of explorationLinks) {
    const links = explorationLinksBySource.get(link.sourcePlantId) ?? [];
    links.push(link);
    explorationLinksBySource.set(link.sourcePlantId, links);
  }

  for (const link of explorationLinks) {
    link.desired = false;
  }

  for (const plant of state.plants) {
    if (!plant.alive || plant.wilt > 0.55 || plant.nutrients < WORLD.exploratoryRootSearchMinNutrients) {
      continue;
    }

    const ownedBodies = frontierOwnership.get(plant.id) ?? [];
    const ownedBodyIds = new Set(ownedBodies.map(({ body }) => body.id));

    const plantLinks = explorationLinksBySource.get(plant.id) ?? [];
    const activeLinks = plantLinks.filter((link) => link.progress > 0.02 && !link.retracting);
    for (const link of activeLinks) {
      const body = getBodyById(link.targetId);
      if (!body) {
        continue;
      }
      const distance = distanceBetween(plant, body);
      const stillValid = body.nutrients > 2
        && ownedBodyIds.has(body.id)
        && distance >= WORLD.exploratoryBodyDistanceMin * 0.7
        && distance <= WORLD.exploratoryBodyDistanceMax;

      if (stillValid) {
        link.desired = true;
      }
    }

    if (activeLinks.some((link) => link.desired)) {
      continue;
    }

    if (plant.exploratoryCooldown > 0) {
      continue;
    }

    let body = null;
    let bestScore = -Infinity;
    for (const ownedBody of ownedBodies) {
      const candidate = ownedBody.body;
      const distance = ownedBody.distance;
      if (
        distance < WORLD.exploratoryBodyDistanceMin
        || distance > WORLD.exploratoryBodyDistanceMax
        || candidate.nutrients <= 2
      ) {
        continue;
      }

      const score = candidate.nutrients / distance;
      if (score > bestScore) {
        bestScore = score;
        body = candidate;
      }
    }

    if (!body) {
      continue;
    }

    let link = plantLinks.find((candidate) => candidate.targetId === body.id);
    if (!link) {
      link = createRootLink(plant.id, "body", body.id, "explore");
    }

    if (link) {
      link.desired = true;
      link.retracting = false;
      plant.exploratoryCooldown = randomInRange(2.4, 5.6);
    }
  }
}

function updateRootLinkLifecycle(dt) {
  markDesiredSupportLinks();
  const frontierOwnership = buildFrontierOwnership();
  updateExploratoryRoots(frontierOwnership);

  for (const link of state.rootLinks) {
    const endpoints = getLinkEndpoints(link);
    if (!endpoints) {
      link.desired = false;
    }

    const sourcePlant = getPlantById(link.sourcePlantId);
    const sourceWeak = !sourcePlant || !sourcePlant.alive || sourcePlant.nutrients < 3.5 || sourcePlant.wilt > 0.65;
    const retractDuration = sourceWeak ? WORLD.supportRootWeakRetractSeconds : link.retractDuration;
    const canRetract = !link.desired && link.packets.length === 0;

    if (canRetract) {
      link.retracting = true;
    }

    if (link.retracting) {
      link.progress = Math.max(0, link.progress - dt / Math.max(retractDuration, 0.05));
    } else if (link.desired) {
      const health = plantHealth(sourcePlant);
      const targetGrowth = link.type === "explore"
        ? lerp(WORLD.exploratoryRootMaxGrowthSeconds, WORLD.exploratoryRootMinGrowthSeconds, health)
        : lerp(WORLD.supportRootMaxGrowthSeconds, WORLD.supportRootMinGrowthSeconds, health);
      link.growthDuration = targetGrowth;
      link.progress = Math.min(1, link.progress + dt / Math.max(link.growthDuration, 0.05));
    }
  }

  state.rootLinks = state.rootLinks.filter((link) => link.progress > 0.001 || link.desired || link.packets.length > 0);
  return frontierOwnership;
}

function applyRootUpkeep(dt) {
  for (const link of state.rootLinks) {
    const endpoints = getLinkEndpoints(link);
    if (!endpoints) {
      continue;
    }

    const length = getLinkCurrentLength(link);
    if (link.type === "explore") {
      const source = endpoints.source;
      const upkeep = WORLD.exploratoryRootUpkeepFull * link.progress * dt;
      source.nutrients = Math.max(0, source.nutrients - upkeep);
      continue;
    }

    const upkeep = WORLD.rootUpkeepPerPixel * length * dt;
    const sourceShare = upkeep * 0.5;
    const targetShare = upkeep - sourceShare;
    endpoints.source.nutrients = Math.max(0, endpoints.source.nutrients - sourceShare);
    endpoints.target.nutrients = Math.max(0, endpoints.target.nutrients - targetShare);
  }
}

function makePacket(link, amount, fromPlantId, targetId, targetKind, color) {
  link.packets.push({
    id: state.nextPacketId++,
    amount,
    fromPlantId,
    targetId,
    targetKind,
    travel: 0,
    color,
  });
}

function updatePacketDispatch(dt) {
  for (const link of state.rootLinks) {
    if (link.type !== "support" || link.progress < 0.92 || link.retracting) {
      continue;
    }

    const endpoints = getLinkEndpoints(link);
    if (!endpoints) {
      continue;
    }

    const plantA = endpoints.source;
    const plantB = endpoints.target;
    if (!plantA || !plantB) {
      continue;
    }

    link.packetCooldown -= dt;
    if (link.packetCooldown > 0) {
      continue;
    }

    const queuedAmount = link.packets.reduce((sum, packet) => sum + packet.amount, 0);
    const nutrientGap = plantA.nutrients - plantB.nutrients;
    const donor = nutrientGap > 0 ? plantA : plantB;
    const receiver = nutrientGap > 0 ? plantB : plantA;

    if (!donor.alive || !receiver.alive || receiver.beingEaten || Math.abs(nutrientGap) < 7 || queuedAmount > 2.8) {
      link.packetCooldown = randomInRange(0.35, 1.2);
      continue;
    }

    const amount = clamp(Math.abs(nutrientGap) * 0.07, WORLD.minPacketAmount, WORLD.maxPacketAmount);
    if (donor.nutrients <= amount + 2) {
      link.packetCooldown = randomInRange(0.4, 1.1);
      continue;
    }

    donor.nutrients -= amount;
    makePacket(link, amount, donor.id, receiver.id, "plant", "rgba(159, 246, 190, 0.95)");
    link.packetCooldown = 1 / WORLD.packetDispatchPerSecond + randomInRange(0.05, 0.45);
  }
}

function updatePackets(dt) {
  for (const link of state.rootLinks) {
    const length = Math.max(getLinkCurrentLength(link), 1);

    for (const packet of link.packets) {
      packet.travel += (WORLD.packetSpeedPixelsPerSecond * dt) / length;
    }

    const arrived = link.packets.filter((packet) => packet.travel >= 1);
    link.packets = link.packets.filter((packet) => packet.travel < 1);

    for (const packet of arrived) {
      if (packet.targetKind === "plant") {
        const plant = getPlantById(packet.targetId);
        if (plant && !plant.beingEaten) {
          plant.nutrients = clamp(plant.nutrients + packet.amount, 0, plant.maxNutrients);
        }
      } else {
        const body = getBodyById(packet.targetId);
        if (body) {
          body.nutrients += packet.amount;
          body.maxNutrients = Math.max(body.maxNutrients, body.nutrients);
        }
      }
    }
  }
}

function chooseProliferationTarget(plant, ownedBodies, plantExploreLinks = []) {
  let bestBody = null;
  let bestScore = -Infinity;

  for (const ownedBody of ownedBodies) {
    const body = ownedBody.body;
    const distance = ownedBody.distance;
    if (distance <= WORLD.feedingRange + 28 || distance > WORLD.bridgeSearchRadius || body.nutrients < 2) {
      continue;
    }

    const score = body.nutrients / distance;
    if (score > bestScore) {
      bestScore = score;
      bestBody = body;
    }
  }

  if (!bestBody) {
    const ownedBodyIds = new Set(ownedBodies.map((ownedBody) => ownedBody.body.id));
    let exploratory = null;
    for (const link of plantExploreLinks) {
      if (link.progress <= 0.35 || link.retracting || !ownedBodyIds.has(link.targetId)) {
        continue;
      }

      const body = getBodyById(link.targetId);
      if (body && (!exploratory || body.nutrients > exploratory.nutrients)) {
        exploratory = body;
      }
    }

    if (exploratory) {
      bestBody = exploratory;
    }
  }

  if (!bestBody) {
    const angle = Math.random() * Math.PI * 2;
    const distance = randomInRange(WORLD.localSproutDistance, WORLD.localSproutDistance + 26);
    return {
      x: plant.x + Math.cos(angle) * distance,
      y: plant.y + Math.sin(angle) * distance,
    };
  }

  const angle = Math.atan2(bestBody.y - plant.y, bestBody.x - plant.x);
  const offsetAngle = angle + randomInRange(-0.45, 0.45);
  const distance = Math.min(WORLD.bridgeStep, Math.max(26, distanceBetween(plant, bestBody) - WORLD.feedingRange * 0.68));

  return {
    x: plant.x + Math.cos(offsetAngle) * distance,
    y: plant.y + Math.sin(offsetAngle) * distance,
  };
}

function attemptPlantProliferation(dt, frontierOwnership = buildFrontierOwnership()) {
  const newPlants = [];
  const explorationLinksBySource = new Map();

  for (const link of state.rootLinks) {
    if (link.type !== "explore") {
      continue;
    }

    const links = explorationLinksBySource.get(link.sourcePlantId) ?? [];
    links.push(link);
    explorationLinksBySource.set(link.sourcePlantId, links);
  }

  for (const plant of state.plants) {
    if (!plant.alive || isPlantWilting(plant)) {
      continue;
    }

    if (plant.proliferationCooldown > 0) {
      continue;
    }

    const ownedBodies = frontierOwnership.get(plant.id) ?? [];
    const plantExploreLinks = explorationLinksBySource.get(plant.id) ?? [];
    const ownedBodyIds = new Set(ownedBodies.map((ownedBody) => ownedBody.body.id));
    const hasOwnedDistantBody = ownedBodies.some(({ distance, body }) => {
      return distance > WORLD.feedingRange + 14
        && distance <= WORLD.bridgeSearchRadius
        && body.nutrients > 2;
    });

    const hasActiveExploratoryRoot = plantExploreLinks.some((link) => {
      return link.progress > 0.35
        && !link.retracting
        && ownedBodyIds.has(link.targetId);
    });

    const frontierBridgingActive = hasOwnedDistantBody || hasActiveExploratoryRoot;
    const effectiveThreshold = Math.max(
      WORLD.initialNutrientsMin,
      plant.proliferationThreshold - (frontierBridgingActive ? WORLD.frontierProliferationThresholdBonus : 0)
    );
    const attemptRate = frontierBridgingActive
      ? WORLD.frontierProliferationAttemptsPerSecond
      : WORLD.proliferateAttemptsPerSecond;

    if (plant.nutrients < effectiveThreshold) {
      continue;
    }

    if (!chancePerSecond(attemptRate, dt)) {
      continue;
    }

    plant.nutrients = Math.max(0, plant.nutrients - WORLD.proliferateAttemptCost);

    const point = chooseProliferationTarget(plant, ownedBodies, plantExploreLinks);
    point.x = clamp(point.x, WORLD.plantMargin, state.width - WORLD.plantMargin);
    point.y = clamp(point.y, WORLD.plantMargin, state.height - WORLD.plantMargin);

    if (!isFarFromPlants(point, 8)) {
      continue;
    }

    const newPlant = createPlant(point.x, point.y, {
      nutrients: randomInRange(12, 18),
      maxNutrients: randomInRange(WORLD.maxNutrientsMin, WORLD.maxNutrientsMax),
    });
    newPlants.push(newPlant);
    state.plantById.set(newPlant.id, newPlant);
    plant.proliferationCooldown = WORLD.plantProliferationCooldownSeconds;
  }

  state.plants.push(...newPlants);
}

function spawnPlantsNearSpawner(spawner) {
  const clusterSize = Math.random() < WORLD.plantSpawnerClusterChance
    ? Math.floor(randomInRange(WORLD.plantSpawnerClusterMin, WORLD.plantSpawnerClusterMax + 1))
    : 1;
  let spawned = 0;

  for (let i = 0; i < clusterSize; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = i === 0
      ? randomInRange(0, WORLD.plantSpawnerRadius * 0.35)
      : randomInRange(8, WORLD.plantSpawnerRadius);
    const point = {
      x: clamp(spawner.x + Math.cos(angle) * distance, WORLD.plantMargin, state.width - WORLD.plantMargin),
      y: clamp(spawner.y + Math.sin(angle) * distance, WORLD.plantMargin, state.height - WORLD.plantMargin),
    };

    if (!isFarFromPlants(point, 8)) {
      continue;
    }

    const plant = createPlant(point.x, point.y);
    state.plants.push(plant);
    state.plantById.set(plant.id, plant);
    spawned += 1;
  }

  return spawned > 0;
}

function updateAnimalSpawners(dt) {
  for (const [kind, spawner] of Object.entries(state.spawners)) {
    if (spawner.enabled && !spawner.wasEnabled) {
      spawner.nextSpawnIn = randomInitialSpawnerInterval(kind);
    }

    if (!spawner.enabled) {
      if (spawner.wasEnabled && (kind === "herbivore" || kind === "carnivore")) {
        const animals = kind === "herbivore" ? state.herbivores : state.carnivores;
        recenterAnimalsToInnerSpawnHome(animals);
      }
      spawner.wasEnabled = false;
      spawner.nextSpawnIn = randomSpawnerInterval(kind);
      continue;
    }

    spawner.wasEnabled = true;

    if (kind === "plant") {
      spawner.nextSpawnIn -= dt;
      if (spawner.nextSpawnIn <= 0) {
        spawnPlantsNearSpawner(spawner);
        spawner.nextSpawnIn = randomSpawnerInterval(kind);
      }
      continue;
    }

    const animals = kind === "herbivore" ? state.herbivores : state.carnivores;
    for (const animal of animals) {
      animal.homeX = spawner.x;
      animal.homeY = spawner.y;
    }

    spawner.nextSpawnIn -= dt;
    if (spawner.nextSpawnIn > 0) {
      continue;
    }

    const point = getSpawnerSpawnPoint(spawner);
    const animal = createAnimal(kind, point.x, point.y, spawner.x, spawner.y);
    if (kind === "herbivore") {
      state.herbivores.push(animal);
    } else {
      state.carnivores.push(animal);
    }
    spawner.nextSpawnIn = randomSpawnerInterval(kind);
  }
}

function updateHerbivores(dt) {
  const survivors = [];
  const newborns = [];
  const huntingCarnivores = state.carnivores.filter((carnivore) => isCarnivoreHunting(carnivore));

  for (const herbivore of state.herbivores) {
    herbivore.isEating = false;
    herbivore.mateCooldown = Math.max(0, herbivore.mateCooldown - dt);
    herbivore.hunger = Math.min(herbivore.hungerMax, herbivore.hunger + herbivore.hungerRate * dt);
    const threat = findClosestThreat(herbivore, huntingCarnivores);
    if (shouldAnimalDieFromHunger(herbivore, Boolean(threat), dt)) {
      addDeathEffect(herbivore);
      dropBodyAt(herbivore.x, herbivore.y, WORLD.herbivoreCorpseNutrients);
      continue;
    }

    if (threat) {
      if (!steerOutOfThicket(herbivore, 1.55, dt, 3)) {
        steerAway(herbivore, threat.carnivore.x, threat.carnivore.y, 1.45, dt, 2.4);
      }
      applyAnimalMotion(herbivore, dt);
      survivors.push(herbivore);
      continue;
    }

    const hungry = herbivore.hunger >= herbivore.hungerMax * 0.5;
    const sated = herbivore.hunger <= herbivore.hungerMax * 0.2;
    const grazingThreshold = herbivore.hungerMax * 0.2;
    const preferredGrazePlant = herbivore.grazingPlantId
      ? getPlantById(herbivore.grazingPlantId)
      : null;
    let grazeTarget = null;
    let closestGrazeDistance = Infinity;

    if (preferredGrazePlant && preferredGrazePlant.alive) {
      const preferredDistance = distanceBetween(herbivore, preferredGrazePlant);
      if (preferredGrazePlant.nutrients > 1.5 && preferredDistance <= WORLD.herbivoreSenseRange) {
        grazeTarget = { plant: preferredGrazePlant, distance: preferredDistance };
        closestGrazeDistance = preferredDistance;
      }
    }

    if (!grazeTarget) {
      for (const plant of state.plants) {
        if (!plant.alive || plant.nutrients <= 1.5) {
          continue;
        }

        const distance = distanceBetween(herbivore, plant);
        if (distance <= WORLD.herbivoreSenseRange && distance < closestGrazeDistance) {
          grazeTarget = { plant, distance };
          closestGrazeDistance = distance;
        }
      }
    }

    const shouldGraze = hungry || (herbivore.grazingPlantId !== null && herbivore.hunger > grazingThreshold);

    if (shouldGraze && grazeTarget) {
      herbivore.grazingPlantId = grazeTarget.plant.id;
      if (grazeTarget.distance <= WORLD.animalContactRadius + WORLD.plantInteractionRadius) {
        grazeTarget.plant.beingEaten = true;
        stopAnimal(herbivore);
        const available = grazeTarget.plant.nutrients;
        const amount = available <= WORLD.herbivoreFinishPlantNutrients
          ? available
          : Math.min(WORLD.herbivoreGrazeRate * dt, available);
        grazeTarget.plant.nutrients = Math.max(0, available - amount);
        herbivore.isEating = amount > 0;
        if (amount >= available || grazeTarget.plant.nutrients <= 0.001) {
          grazeTarget.plant.alive = false;
        }
        herbivore.hunger = Math.max(0, herbivore.hunger - amount * WORLD.herbivoreGrazeHungerReliefRatioPerNutrient * herbivore.hungerMax);
        addAnimalGrowthNutrients(herbivore, amount);
      } else {
        moveToward(herbivore, grazeTarget.plant.x, grazeTarget.plant.y, 1, dt);
      }
      applyAnimalMotion(herbivore, dt);
      survivors.push(herbivore);
      continue;
    }

    if (sated || !grazeTarget) {
      herbivore.grazingPlantId = null;
    }

    if (tryAnimalMating(herbivore, state.herbivores, newborns, dt)) {
      applyAnimalMotion(herbivore, dt);
      survivors.push(herbivore);
      continue;
    }

    const homeActive = state.spawners.herbivore.enabled;
    updateIdleBehavior(
      herbivore,
      homeActive ? WORLD.herbivoreBaseHangRadius : WORLD.herbivoreBaseHangRadius * 2.4,
      0.72,
      dt
    );

    applyAnimalMotion(herbivore, dt);
    survivors.push(herbivore);
  }

  state.herbivores = [...survivors, ...newborns];
}

function updateCarnivores(dt) {
  const survivors = [];
  const newborns = [];
  const killedCarnivoreIds = new Set();

  for (const carnivore of state.carnivores) {
    if (killedCarnivoreIds.has(carnivore.id)) {
      continue;
    }

    carnivore.mateCooldown = Math.max(0, carnivore.mateCooldown - dt);
    carnivore.fightCooldown = Math.max(0, carnivore.fightCooldown - dt);
    carnivore.hunger = Math.min(carnivore.hungerMax, carnivore.hunger + carnivore.hungerRate * dt);
    const hungry = carnivore.hunger >= carnivore.hungerMax * 0.5;
    let preyTarget = null;
    let closestPreyDistance = Infinity;
    for (const herbivore of state.herbivores) {
      if (!herbivore.mature) {
        continue;
      }

      const distance = distanceBetween(carnivore, herbivore);
      if (distance <= WORLD.carnivoreSenseRange && distance < closestPreyDistance) {
        preyTarget = { herbivore, distance };
        closestPreyDistance = distance;
      }
    }
    const chasingPrey = carnivore.pauseTimer <= 0 && hungry && Boolean(preyTarget);

    if (shouldAnimalDieFromHunger(carnivore, chasingPrey, dt)) {
      addDeathEffect(carnivore);
      dropBodyAt(carnivore.x, carnivore.y, WORLD.carnivoreCorpseNutrients);
      continue;
    }

    if (carnivore.pauseTimer > 0) {
      carnivore.pauseTimer = Math.max(0, carnivore.pauseTimer - dt);
      slowAnimal(carnivore, dt);
      applyAnimalMotion(carnivore, dt);
      survivors.push(carnivore);
      continue;
    }

    if (hungry && preyTarget) {
      carnivore.fightTargetId = null;
      carnivore.fightTimer = 0;
      if (steerOutOfThicket(carnivore, 1.25, dt, 2.6)) {
        // Thicket escape takes priority over chasing prey at the canvas edge.
      } else if (preyTarget.distance > getAnimalPhysicalRadius(carnivore) + getAnimalPhysicalRadius(preyTarget.herbivore)) {
        steerToward(carnivore, preyTarget.herbivore.x, preyTarget.herbivore.y, 1.18, dt, 2.1);
      } else {
        stopAnimal(carnivore);
      }
      applyAnimalMotion(carnivore, dt);
      survivors.push(carnivore);
      continue;
    }

    if (tryCarnivoreFight(carnivore, killedCarnivoreIds, dt)) {
      applyAnimalMotion(carnivore, dt);
      survivors.push(carnivore);
      continue;
    }

    if (tryAnimalMating(carnivore, state.carnivores, newborns, dt)) {
      applyAnimalMotion(carnivore, dt);
      survivors.push(carnivore);
      continue;
    }

    const homeActive = state.spawners.carnivore.enabled;
    updateIdleBehavior(
      carnivore,
      homeActive ? WORLD.carnivoreBaseHangRadius : WORLD.carnivoreBaseHangRadius * 2.4,
      0.76,
      dt
    );

    applyAnimalMotion(carnivore, dt);
    survivors.push(carnivore);
  }

  state.carnivores = [...survivors, ...newborns].filter((carnivore) => !killedCarnivoreIds.has(carnivore.id));
}

function collectSupportNeighbors(plantId) {
  const neighbors = [];
  for (const link of state.rootLinks) {
    if (link.type !== "support" || link.progress < 0.7) {
      continue;
    }
    if (link.sourcePlantId === plantId && link.targetKind === "plant") {
      const target = getPlantById(link.targetId);
      if (target) {
        neighbors.push({ plant: target, link });
      }
    } else if (link.targetKind === "plant" && link.targetId === plantId) {
      const source = getPlantById(link.sourcePlantId);
      if (source) {
        neighbors.push({ plant: source, link });
      }
    }
  }
  return neighbors;
}

function transferPrunedNutrients(victim, neighbors) {
  const recovered = Math.max(0, victim.nutrients) * clamp(WORLD.sacrificeRecoveredShare, 0, 1);
  if (recovered <= 0) {
    return false;
  }

  const viableNeighbors = neighbors.filter(({ plant }) => {
    return plant.alive && plant.id !== victim.id && plant.nutrients < plant.maxNutrients - 0.1;
  });
  if (viableNeighbors.length === 0) {
    return false;
  }

  const share = recovered / viableNeighbors.length;
  let transferred = 0;

  for (const neighbor of viableNeighbors) {
    const recipient = neighbor.plant;
    const amount = Math.min(share, recipient.maxNutrients - recipient.nutrients);
    if (amount <= 0) {
      continue;
    }

    recipient.nutrients += amount;
    transferred += amount;
    state.salvageEffects.push({
      fromX: victim.x,
      fromY: victim.y,
      toX: recipient.x,
      toY: recipient.y,
      amount,
      age: 0,
      duration: 0.8,
    });
    neighbor.link.desired = false;
  }

  victim.nutrients = Math.max(0, victim.nutrients - transferred);
  return transferred > 0;
}

function updateNetworkPruning() {
  for (const plant of state.plants) {
    if (!plant.alive) {
      continue;
    }

    const stressed = plant.nutrients < WORLD.sacrificeThreshold && plant.wilt > WORLD.sacrificeWiltThreshold;
    if (!stressed) {
      continue;
    }

    const neighbors = collectSupportNeighbors(plant.id);
    const healthyNeighbors = neighbors.filter(({ plant: neighbor }) => {
      return plantHealth(neighbor) > WORLD.sacrificeNeighborHealthThreshold;
    });
    if (healthyNeighbors.length < 2) {
      continue;
    }

    const healthierAverage = healthyNeighbors.reduce((sum, neighbor) => sum + neighbor.plant.nutrients, 0) / healthyNeighbors.length;
    if (healthierAverage < plant.nutrients) {
      continue;
    }

    const salvaged = transferPrunedNutrients(plant, healthyNeighbors);
    if (!salvaged) {
      continue;
    }

    plant.alive = false;
    plant.wilt = Math.max(plant.wilt, 0.82);
  }
}

function cleanupDepletedEntities() {
  state.bodies = state.bodies.filter((body) => body.nutrients > WORLD.bodyRemovalThreshold);
  state.plants = state.plants.filter((plant) => plant.alive);
  refreshEntityIndexes();
}

function stepSimulation(dt) {
  refreshEntityIndexes();
  state.worldAge += dt;
  updateSpawnerAnimations(dt);
  updateAnimalSpawners(dt);
  updateHerbivores(dt);
  updateCarnivores(dt);
  resolvePhysicalInteractions();
  resolvePredationContacts();
  updateBodies(dt);
  updateDeathEffects(dt);
  updateSalvageEffects(dt);
  updatePlantFeeding(dt);
  updatePlantUpkeep(dt);
  const frontierOwnership = updateRootLinkLifecycle(dt);
  applyRootUpkeep(dt);
  updatePacketDispatch(dt);
  updatePackets(dt);
  updateNetworkPruning();
  attemptPlantProliferation(dt, frontierOwnership);
  cleanupDepletedEntities();
  render();
  syncHud();
}

function syncHud() {
  speedValue.textContent = `${state.speedMultiplier.toFixed(2)}x`;
}

function renderBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, state.height);
  gradient.addColorStop(0, "#081112");
  gradient.addColorStop(0.55, "#0b1515");
  gradient.addColorStop(1, "#0d1716");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, state.width, state.height);

  const thicket = getThicketBounds();
  const edgeTint = "rgba(33, 70, 47, 0.2)";
  ctx.fillStyle = edgeTint;
  ctx.fillRect(0, 0, state.width, thicket.top);
  ctx.fillRect(0, thicket.bottom, state.width, state.height - thicket.bottom);
  ctx.fillRect(0, thicket.top, thicket.left, thicket.bottom - thicket.top);
  ctx.fillRect(thicket.right, thicket.top, state.width - thicket.right, thicket.bottom - thicket.top);

  ctx.strokeStyle = "rgba(98, 162, 120, 0.16)";
  ctx.lineWidth = 2;
  ctx.strokeRect(thicket.left, thicket.top, thicket.right - thicket.left, thicket.bottom - thicket.top);

  for (let i = 0; i < 10; i += 1) {
    const x = (i * 137.2 + state.worldAge * 3.8) % (state.width + 60) - 30;
    const y = (i * 79.1) % state.height;
    ctx.fillStyle = "rgba(150, 190, 176, 0.014)";
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderBodies() {
  for (const body of state.bodies) {
    const radius = bodyVisualRadius(body);
    const ratio = clamp(body.nutrients / Math.max(body.maxNutrients, 0.001), 0, 1);
    ctx.fillStyle = `rgba(124, 88, 68, ${0.62 + ratio * 0.24})`;
    ctx.beginPath();
    ctx.arc(body.x, body.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderDeathEffects() {
  for (const effect of state.deathEffects) {
    const progress = clamp(effect.age / effect.duration, 0, 1);
    const alpha = (1 - progress) * 0.42;
    const color = effect.kind === "carnivore"
      ? `rgba(235, 118, 98, ${alpha})`
      : `rgba(240, 214, 142, ${alpha})`;
    const radius = (5 + progress * 7) * effect.sizeScale;
    const squash = 1 - progress * 0.42;

    ctx.save();
    ctx.translate(effect.x, effect.y);
    ctx.rotate(effect.angle + progress * 0.28);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3 * (1 - progress * 0.35);
    ctx.beginPath();
    ctx.ellipse(0, 0, radius, radius * squash, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(-radius * 0.35, -radius * 0.12, 1.3 * (1 - progress), 0, Math.PI * 2);
    ctx.arc(radius * 0.3, radius * 0.16, 1.1 * (1 - progress), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function renderSalvageEffects() {
  if (!networkToggle.checked) {
    return;
  }

  for (const effect of state.salvageEffects) {
    const progress = clamp(effect.age / effect.duration, 0, 1);
    const alpha = (1 - progress) * clamp(effect.amount / 6, 0.18, 0.58);
    const x = lerp(effect.fromX, effect.toX, progress);
    const y = lerp(effect.fromY, effect.toY, progress);

    ctx.strokeStyle = `rgba(255, 198, 122, ${alpha * 0.7})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(effect.fromX, effect.fromY);
    ctx.lineTo(effect.toX, effect.toY);
    ctx.stroke();

    ctx.fillStyle = `rgba(255, 216, 146, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.8 + progress * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderFeedingLinks() {
  if (!networkToggle.checked) {
    return;
  }

  for (const feed of state.activeFeeds) {
    const plant = getPlantById(feed.plantId);
    const body = getBodyById(feed.bodyId);
    if (!plant || !body) {
      continue;
    }

    const alpha = clamp(feed.amount * 2.5, 0.08, 0.35);
    ctx.strokeStyle = `rgba(234, 198, 128, ${alpha})`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(plant.x, plant.y);
    ctx.lineTo(body.x, body.y);
    ctx.stroke();

    const pulse = (state.worldAge * 2.2) % 1;
    const x = body.x + (plant.x - body.x) * pulse;
    const y = body.y + (plant.y - body.y) * pulse;
    ctx.fillStyle = "rgba(255, 217, 140, 0.88)";
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderLinkPackets(link) {
  const endpoints = getLinkEndpoints(link);
  if (!endpoints) {
    return;
  }

  const { source, target } = endpoints;
  for (const packet of link.packets) {
    const from = packet.fromPlantId === source.id ? source : target;
    const to = packet.fromPlantId === source.id ? target : source;
    const travel = clamp(packet.travel, 0, 1) * link.progress;
    const x = from.x + (to.x - from.x) * travel;
    const y = from.y + (to.y - from.y) * travel;
    ctx.fillStyle = packet.color;
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderRoots() {
  if (!networkToggle.checked) {
    return;
  }

  for (const link of state.rootLinks) {
    const endpoints = getLinkEndpoints(link);
    const tip = getLinkTargetPoint(link);
    if (!endpoints || !tip || link.progress <= 0.01) {
      continue;
    }

    const { source } = endpoints;
    const alpha = link.type === "explore" ? 0.2 + link.progress * 0.22 : 0.18 + link.progress * 0.24;
    const lineWidth = link.type === "explore" ? 1.15 : 1.2;

    ctx.strokeStyle = link.type === "explore"
      ? `rgba(180, 223, 171, ${alpha})`
      : `rgba(115, 225, 160, ${alpha})`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    if (link.type === "explore") {
      ctx.strokeStyle = `rgba(225, 244, 190, ${0.12 + link.progress * 0.14})`;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = `rgba(240, 247, 196, ${0.16 + link.progress * 0.18})`;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    renderLinkPackets(link);
  }
}

function renderPlants() {
  for (const plant of state.plants) {
    const growIn = clamp((state.worldAge - plant.bornAt) / WORLD.plantGrowInSeconds, 0, 1);
    const radius = plantVisualRadius(plant) * (0.55 + growIn * 0.45);
    const nutrientRatio = clamp(plant.nutrients / plant.maxNutrients, 0, 1);
    const wiltFactor = plant.wilt;

    ctx.strokeStyle = `rgba(28, 84, 44, ${0.44 + nutrientRatio * 0.3})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(plant.x, plant.y, radius + 1, 0, Math.PI * 2);
    ctx.stroke();

    const green = Math.round(150 + nutrientRatio * 90 - wiltFactor * 54);
    const red = Math.round(62 + nutrientRatio * 26 + wiltFactor * 58);
    const blue = Math.round(76 - wiltFactor * 36);
    const alpha = plant.alive ? 0.75 + nutrientRatio * 0.2 : 0.42;
    ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(plant.x, plant.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (wiltFactor > 0.1 || !plant.alive) {
      ctx.strokeStyle = `rgba(210, 155, 90, ${Math.max(wiltFactor * 0.45, 0.3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(plant.x, plant.y, radius + 1.8, Math.PI * 0.2, Math.PI * 1.2);
      ctx.stroke();
    }
  }
}

function renderMeter(x, y, width, ratio, fillStyle, strokeStyle) {
  const clampedRatio = clamp(ratio, 0, 1);
  ctx.fillStyle = "rgba(6, 12, 12, 0.72)";
  ctx.fillRect(x - width / 2, y, width, 4);
  ctx.fillStyle = fillStyle;
  ctx.fillRect(x - width / 2, y, width * clampedRatio, 4);
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 0.7;
  ctx.strokeRect(x - width / 2, y, width, 4);
}

function renderDebugOverlay() {
  if (!DEBUG_MODE_ENABLED) {
    return;
  }

  const innerBounds = getInnerSpawnBounds();
  ctx.strokeStyle = "rgba(128, 197, 230, 0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(
    innerBounds.left,
    innerBounds.top,
    innerBounds.right - innerBounds.left,
    innerBounds.bottom - innerBounds.top
  );
  ctx.setLineDash([]);

  for (const plant of state.plants) {
    renderMeter(
      plant.x,
      plant.y - plantVisualRadius(plant) - 8,
      18,
      plant.nutrients / plant.maxNutrients,
      "rgba(134, 232, 157, 0.95)",
      "rgba(30, 68, 40, 0.95)"
    );
  }

  if (!state.spawners.herbivore.enabled) {
    for (const herbivore of state.herbivores) {
      ctx.strokeStyle = "rgba(240, 214, 142, 0.28)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(herbivore.x, herbivore.y);
      ctx.lineTo(herbivore.homeX, herbivore.homeY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(240, 214, 142, 0.95)";
      ctx.beginPath();
      ctx.arc(herbivore.homeX, herbivore.homeY, 2.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(240, 214, 142, 0.52)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(herbivore.homeX, herbivore.homeY, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  for (const herbivore of state.herbivores) {
    renderMeter(
      herbivore.x,
      herbivore.y - 9,
      16,
      1 - herbivore.hunger / herbivore.hungerMax,
      "rgba(240, 214, 142, 0.95)",
      "rgba(92, 74, 34, 0.95)"
    );
  }

  if (!state.spawners.carnivore.enabled) {
    for (const carnivore of state.carnivores) {
      ctx.strokeStyle = "rgba(235, 118, 98, 0.28)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(carnivore.x, carnivore.y);
      ctx.lineTo(carnivore.homeX, carnivore.homeY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(235, 118, 98, 0.95)";
      ctx.beginPath();
      ctx.arc(carnivore.homeX, carnivore.homeY, 2.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(235, 118, 98, 0.52)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(carnivore.homeX, carnivore.homeY, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  for (const carnivore of state.carnivores) {
    renderMeter(
      carnivore.x,
      carnivore.y - 10,
      18,
      1 - carnivore.hunger / carnivore.hungerMax,
      "rgba(235, 118, 98, 0.95)",
      "rgba(110, 40, 34, 0.95)"
    );
  }
}

function renderAnimals() {
  for (const herbivore of state.herbivores) {
    ctx.save();
    ctx.translate(herbivore.x, herbivore.y);
    ctx.rotate(herbivore.facingAngle);
    ctx.scale(herbivore.sizeScale, herbivore.sizeScale);
    ctx.fillStyle = "rgba(240, 214, 142, 0.95)";
    ctx.beginPath();
    ctx.ellipse(0, 0, 6.5, 4.1, 0, 0, Math.PI * 2);
    ctx.fill();

    if (herbivore.isEating) {
      for (let i = 0; i < 4; i += 1) {
        const cycle = (state.worldAge * 2.8 + herbivore.id * 0.37 + i * 0.23) % 1;
        const drift = cycle * 8;
        const side = i % 2 === 0 ? -1 : 1;
        const x = 7.2 + drift * 0.45;
        const y = side * (1.1 + cycle * 3.2) + Math.sin(state.worldAge * 8 + i) * 0.35;
        const alpha = (1 - cycle) * 0.52;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(side * 0.7 + cycle * 1.6);
        ctx.fillStyle = `rgba(151, 226, 116, ${alpha})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, 1.5 * (1 - cycle * 0.25), 0.72 * (1 - cycle * 0.15), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  for (const carnivore of state.carnivores) {
    const fighting = carnivore.fightTargetId !== null;
    const fightIntensity = fighting
      ? clamp(carnivore.fightTimer / Math.max(WORLD.carnivoreFightDurationSeconds, 0.001), 0.35, 1)
      : 0;
    const fightJitter = fighting ? Math.sin(state.worldAge * 30 + carnivore.id) * fightIntensity * 0.55 : 0;

    ctx.save();
    ctx.translate(carnivore.x + fightJitter, carnivore.y - fightJitter * 0.35);
    ctx.rotate(carnivore.facingAngle);
    ctx.scale(carnivore.sizeScale, carnivore.sizeScale);
    ctx.fillStyle = "rgba(235, 118, 98, 0.96)";

    if (catModeToggle.checked) {
      const hunting = isCarnivoreHunting(carnivore);
      const speedRatio = clamp(carnivore.currentSpeed / Math.max(carnivore.speed, 1), 0, 1.2);
      const bodyStretch = 1 + speedRatio * 0.14;
      const bodySquash = 1 - speedRatio * 0.08;
      const bodyBob = hunting ? 0 : Math.sin(state.worldAge * 10 + carnivore.id * 0.7) * 0.35 * speedRatio;
      const tailSwish = hunting ? 0 : Math.sin(state.worldAge * 7 + carnivore.id * 0.9) * 2.8;

      ctx.strokeStyle = "rgba(235, 118, 98, 0.94)";
      ctx.lineWidth = 2.1;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-6.9, bodyBob * 0.35);
      ctx.quadraticCurveTo(-11.3, tailSwish * 0.45, -13.8, tailSwish);
      ctx.stroke();

      ctx.save();
      ctx.translate(0, bodyBob);
      ctx.scale(bodyStretch, bodySquash);
      ctx.beginPath();
      ctx.ellipse(0.4, 0, 7.2, 4.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.moveTo(1.8, -3.8);
      ctx.lineTo(4.8, -8.4);
      ctx.lineTo(6.2, -2.2);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(1.8, 3.8);
      ctx.lineTo(4.8, 8.4);
      ctx.lineTo(6.2, 2.2);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(252, 201, 188, 0.92)";
      ctx.beginPath();
      ctx.moveTo(2.45, -3.7);
      ctx.lineTo(4.45, -6.8);
      ctx.lineTo(5.15, -2.7);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(2.45, 3.7);
      ctx.lineTo(4.45, 6.8);
      ctx.lineTo(5.15, 2.7);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.ellipse(0, 0, 7.9, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (fighting) {
      for (let i = 0; i < 4; i += 1) {
        const cycle = (state.worldAge * 4.2 + carnivore.id * 0.19 + i * 0.27) % 1;
        const side = i % 2 === 0 ? -1 : 1;
        const angle = side * (0.65 + cycle * 0.5);
        const distance = 7.5 + cycle * 4.5 * fightIntensity;
        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance * 0.75;
        const alpha = (1 - cycle) * (0.28 + fightIntensity * 0.35);

        ctx.strokeStyle = `rgba(255, 190, 96, ${alpha})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(x - side * 1.6, y - 0.8);
        ctx.lineTo(x + side * 1.6, y + 0.8);
        ctx.stroke();
      }

      ctx.strokeStyle = `rgba(255, 118, 96, ${0.12 + fightIntensity * 0.18})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 8.5 + fightIntensity * 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function renderSpawner(kind, spawner) {
  if (spawner.visibleScale <= 0.01) {
    return;
  }

  const activeColor = kind === "herbivore"
    ? "rgba(240, 214, 142, 0.95)"
    : kind === "carnivore"
      ? "rgba(235, 118, 98, 0.96)"
      : "rgba(112, 225, 138, 0.96)";
  const color = spawner.blockedByThicket ? "rgba(128, 144, 138, 0.86)" : activeColor;
  const scale = spawner.visibleScale;
  const baseGlowRadius = kind === "plant" ? WORLD.spawnerDragRadius + 8 : WORLD.spawnerDragRadius + 5;
  const glowRadius = baseGlowRadius * scale;
  const bodyRadius = WORLD.spawnerDragRadius * scale;
  const innerRadius = Math.max(2.2, (WORLD.spawnerDragRadius - 5) * scale);
  const centerDotRadius = Math.max(1.4, 4.2 * scale);

  ctx.save();
  ctx.fillStyle = color.replace("0.96", "0.12").replace("0.95", "0.12");
  ctx.beginPath();
  ctx.arc(spawner.x, spawner.y, glowRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = kind === "plant" ? 2.2 : 2;
  ctx.beginPath();
  ctx.arc(spawner.x, spawner.y, bodyRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(7, 30, 33, 0.78)";
  ctx.beginPath();
  ctx.arc(spawner.x, spawner.y, innerRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(spawner.x, spawner.y, centerDotRadius, 0, Math.PI * 2);
  ctx.fill();

  if (kind === "plant" && DEBUG_MODE_ENABLED) {
    ctx.strokeStyle = "rgba(112, 225, 138, 0.42)";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(spawner.x, spawner.y, WORLD.plantSpawnerRadius * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (DEBUG_MODE_ENABLED) {
    const labelBase = kind === "herbivore" ? "HERBIVORE" : kind === "carnivore" ? "CARNIVORE" : "PLANT";
    const label = spawner.blockedByThicket ? `${labelBase} OFF` : labelBase;
    ctx.fillStyle = "rgba(226, 242, 236, 0.9)";
    ctx.font = "600 10px 'Trebuchet MS', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, spawner.x, spawner.y - bodyRadius - 10);
  }

  if (spawner.blockedByThicket) {
    ctx.strokeStyle = "rgba(230, 238, 234, 0.72)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(spawner.x - innerRadius * 0.8, spawner.y - innerRadius * 0.8);
    ctx.lineTo(spawner.x + innerRadius * 0.8, spawner.y + innerRadius * 0.8);
    ctx.moveTo(spawner.x + innerRadius * 0.8, spawner.y - innerRadius * 0.8);
    ctx.lineTo(spawner.x - innerRadius * 0.8, spawner.y + innerRadius * 0.8);
    ctx.stroke();
  }
  ctx.restore();
}

function renderSpawners() {
  renderSpawner("herbivore", state.spawners.herbivore);
  renderSpawner("carnivore", state.spawners.carnivore);
  renderSpawner("plant", state.spawners.plant);
}

function render() {
  renderBackground();
  renderRoots();
  renderFeedingLinks();
  renderSalvageEffects();
  renderBodies();
  renderDeathEffects();
  renderPlants();
  renderAnimals();
  renderDebugOverlay();
  renderSpawners();
}

function syncFullscreenButton() {
  fullscreenButton.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
}

function setSettingsOpen(open) {
  document.body.classList.toggle("settings-open", open);
  settingsButton.setAttribute("aria-expanded", String(open));
}

function tick(timestamp) {
  if (!state.lastFrameAt) {
    state.lastFrameAt = timestamp;
  }

  const realDt = Math.min(0.05, (timestamp - state.lastFrameAt) / 1000);
  state.lastFrameAt = timestamp;

  if (!state.paused) {
    stepSimulation(realDt * state.speedMultiplier);
  } else {
    render();
    syncHud();
  }

  requestAnimationFrame(tick);
}

function resetWorld() {
  resizeCanvas();
  spawnInitialWorld();
  syncHud();
}

function resizeCanvasAfterLayout() {
  resizeCanvas();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      resizeCanvas();
    });
  });
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * state.width,
    y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * state.height,
  };
}

function findSpawnerAt(point) {
  const hitRadius = WORLD.spawnerDragRadius + 10;

  for (let i = SPAWNER_KINDS.length - 1; i >= 0; i -= 1) {
    const kind = SPAWNER_KINDS[i];
    const spawner = state.spawners[kind];
    if (distanceBetween(point, spawner) <= hitRadius) {
      return kind;
    }
  }

  return null;
}

function updateDraggedSpawner(point) {
  const kind = state.draggedSpawnerKind;
  if (!kind) {
    return;
  }

  const spawner = state.spawners[kind];
  spawner.x = clamp(point.x, WORLD.spawnerDragRadius, state.width - WORLD.spawnerDragRadius);
  spawner.y = clamp(point.y, WORLD.spawnerDragRadius, state.height - WORLD.spawnerDragRadius);
  spawner.blockedByThicket = isPointInsideThicket(spawner.x, spawner.y);
  spawner.enabled = !spawner.blockedByThicket;
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || state.draggedSpawnerKind) {
    return;
  }

  const point = getCanvasPoint(event);
  const kind = findSpawnerAt(point);
  if (!kind) {
    return;
  }

  const spawner = state.spawners[kind];
  spawner.dragging = true;
  state.draggedSpawnerKind = kind;
  state.draggedPointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  updateDraggedSpawner(point);
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== state.draggedPointerId) {
    return;
  }

  updateDraggedSpawner(getCanvasPoint(event));
});

function releaseDraggedSpawner(event) {
  if (event.pointerId !== state.draggedPointerId || !state.draggedSpawnerKind) {
    return;
  }

  const kind = state.draggedSpawnerKind;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  snapSpawnerToSeat(kind);
  state.draggedSpawnerKind = null;
  state.draggedPointerId = null;
}

canvas.addEventListener("pointerup", releaseDraggedSpawner);
canvas.addEventListener("pointercancel", releaseDraggedSpawner);

speedInput.addEventListener("input", () => {
  state.speedMultiplier = Number(speedInput.value);
  speedValue.textContent = `${state.speedMultiplier.toFixed(2)}x`;
});

fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await arenaPanel.requestFullscreen();
  }
});

settingsButton.addEventListener("click", () => {
  setSettingsOpen(!document.body.classList.contains("settings-open"));
  resizeCanvasAfterLayout();
});

window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 720px)").matches) {
    setSettingsOpen(false);
  }
  resizeCanvasAfterLayout();
});

document.addEventListener("fullscreenchange", () => {
  syncFullscreenButton();
  resizeCanvasAfterLayout();
});

resizeCanvas();
spawnInitialWorld();
syncHud();
syncFullscreenButton();
requestAnimationFrame(tick);
