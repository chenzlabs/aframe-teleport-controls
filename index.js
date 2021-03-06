/* global AFRAME */
var parabolicCurve = require('./lib/ParabolicCurve');
var RayCurve = require('./lib/RayCurve');

if (typeof AFRAME === 'undefined') {
  throw new Error('Component attempted to register before AFRAME was available.');
}

var buttons = ['trackpad', 'trigger', 'grip', 'menu', 'thumbstick', 'A', 'B', 'X', 'Y', 'surface', 'point', 'pointing', 'pistol', 'thumb'];
var events = ['down', 'up', 'open', 'close', 'start', 'end', 'touchstart', 'touchend'];

/* global THREE AFRAME  */
AFRAME.registerComponent('teleport-controls', {
  schema: {
    enabled: {default: true, type:  'boolean'},
    type: {default: 'parabolic', oneOf: ['parabolic', 'line']},
    button: {default: 'pointing', oneOf: buttons},
    startEvent: {default: 'start', oneOf: events},
    endEvent: {default: 'end', oneOf: events},
    collisionEntity: { type: 'selector' },
    objects: {default: ''},
    hitEntity: {type: 'selector'},
    playerEntity: { type: 'selector' },
    defaultPlaneSize: {default: 5000},
    hitCylinderColor: {type: 'color', default: '#99ff99'},
    hitCylinderRadius: {default: 0.25, min: 0},
    hitCylinderHeight: {default: 0.3, min: 0},
    maxLength: {default: 10, min: 0, if: {type: ['line']}},
    curveNumberPoints: {default: 30, min: 2, if: {type: ['parabolic']}},
    curveLineWidth: {default: 0.025},
    curveHitColor: {type: 'color', default: '#99ff99'},
    curveMissColor: {type: 'color', default: '#ff0000'},
    curveShootingSpeed: {default: 5, min: 0, if: {type: ['parabolic']}},
    landingNormal: {type: 'vec3', default: '0 1 0'},
    landingMaxAngle: {default: '45', min: 0, max: 360}
  },

  init: function () {
    this.active = false;
    this.obj = this.el.object3D;
    this.hitPoint = new THREE.Vector3();
    this.hit = false;
    this.prevHeightDiff = 0;
    this.referenceNormal = new THREE.Vector3();
    this.curveMissColor = new THREE.Color();
    this.curveHitColor = new THREE.Color();
    this.raycaster = new THREE.Raycaster();
    this.refreshObjects = this.refreshObjects.bind(this);

    this.defaultPlane = this.createDefaultPlane();

    this.teleportEntity = document.createElement('a-entity');
    this.teleportEntity.className = 'teleport-ray';
    this.teleportEntity.setAttribute('visible', false);
    this.el.sceneEl.appendChild(this.teleportEntity);

    this.onButtonDown = this.onButtonDown.bind(this);
    this.onButtonUp = this.onButtonUp.bind(this);
    this.el.addEventListener(this.data.button + this.data.startEvent, this.onButtonDown);
    this.el.addEventListener(this.data.button + this.data.endEvent, this.onButtonUp);
  },

  onButtonDown: function (evt) {
    this.active = this.data.enabled;
  },

  onButtonUp: function (evt) {
    if (!this.active) { return; }

    // Jump!

    // Hide the hit point and the curve
    this.active = false;
    this.hitEntity.setAttribute('visible', false);
    this.teleportEntity.setAttribute('visible', false);

    if (!this.hit) {
      // Button released but not hit point
      return;
    }

    // make sure world matrix is updated
    this.el.sceneEl.object3D.updateMatrixWorld();
    // @todo Create this aux vectors outside
    var cameraEl = this.el.sceneEl.camera.el;
    var camPosition = new THREE.Vector3().copy(cameraEl.getAttribute('position'));
    // account for camera world position e.g. when not direct descendant of scene
    var camWorldPosition = new THREE.Vector3().copy(cameraEl.object3D.getWorldPosition());
    // account for user height that the camera is supposed to be enforcing
    // (TODO: which should be how high they are off the ground right now, really)
    // (this.prevHeightDiff was trying to represent that value, but didn't handle world position)
    var yoffset = camPosition.y; // cameraEl.components.camera.data.userHeight;
    var newCamPositionY = camPosition.y + yoffset - camWorldPosition.y + this.hitPoint.y;
    var newCamPosition = new THREE.Vector3(this.hitPoint.x + camPosition.x - camWorldPosition.x, newCamPositionY, this.hitPoint.z + camPosition.z - camWorldPosition.z);
    var playerEl = this.data.playerEntity;
    if (playerEl) {
      // move the player, not the camera and controllers all separately
      var playerPosition = new THREE.Vector3().copy(playerEl.getAttribute('position'));
      var newPlayerPosition = new THREE.Vector3().copy(newCamPosition).sub(camPosition).add(playerPosition);
      playerEl.setAttribute('position', newPlayerPosition);
      this.el.emit('teleported', {oldPlayerPosition: playerPosition, newPlayerPosition: newPlayerPosition, hitPoint: this.hitPoint});
    } else {
      cameraEl.setAttribute('position', newCamPosition);

      // Find the hands and move them proportionally
      var hands = this.el.sceneEl.querySelectorAll('a-entity[tracked-controls]');
      for (var i = 0; i < hands.length; i++) {
        // make sure we don't move the camera twice
        if (hands[i] === cameraEl) { continue; }
        var position = hands[i].getAttribute('position');
        var pos = new THREE.Vector3().copy(position);
        var diff = camPosition.clone().sub(pos);
        var newPosition = newCamPosition.clone().sub(diff);
        hands[i].setAttribute('position', newPosition);
      }

      this.el.emit('teleported', {oldCamPosition: camPosition, newCamPosition: newCamPosition, hitPoint: this.hitPoint});
    }
  },

  play: function () {
    this.el.sceneEl.addEventListener('child-attached', this.refreshObjects);
    this.el.sceneEl.addEventListener('child-detached', this.refreshObjects);
  },

  pause: function () {
    this.el.sceneEl.removeEventListener('child-attached', this.refreshObjects);
    this.el.sceneEl.removeEventListener('child-detached', this.refreshObjects);
  },

  update: function (oldData) {
    this.referenceNormal.copy(this.data.landingNormal);
    this.curveMissColor.set(this.data.curveMissColor);
    this.curveHitColor.set(this.data.curveHitColor);

    if (oldData.curveNumberPoints !== this.data.curveNumberPoints
      || oldData.type !== this.data.type
      || oldData.curveLineWidth !== this.data.curveLineWidth) {
      this.createLine();
    }

    if (this.data.hitEntity) {
      this.hitEntity = this.data.hitEntity;
    } else {
      this.hitEntity = this.createHitEntity();
    }
    this.hitEntity.setAttribute('visible', false);

    if (!this.data.enabled) { this.active = false; }

    if (oldData.button !== this.data.button
     || oldData.startEvent !== this.data.startEvent) {
      this.el.removeEventListener(oldData.button + oldData.startEvent, this.onButtonDown);
      this.el.addEventListener(this.data.button + this.data.startEvent, this.onButtonDown);
    }
    if (oldData.button !== this.data.button
     || oldData.endEvent !== this.data.endEvent) {
      this.el.removeEventListener(oldData.button + oldData.endEvent, this.onButtonUp);
      this.el.addEventListener(this.data.button + this.data.endEvent, this.onButtonUp);
    }
    this.refreshObjects();
  },

  /**
   * Update list of objects to test for intersection.
   **/
  refreshObjects: function () {
    var data = this.data;
    var i;
    var objectEls;

    // Push meshes onto list of objects to intersect.
    if (data.objects) {
      objectEls = this.el.sceneEl.querySelectorAll(data.objects);
      this.objects = [];
      for (i = 0; i < objectEls.length; i++) {
        this.objects.push(objectEls[i].object3D);
      }
      return;
    }
 
    // If objects not defined, intersect with everything.
    this.objects = this.el.sceneEl.object3D.children;
  },
 
  remove: function () {
    // @todo Remove entities created
  },

  tick: (function () {
    var p0 = new THREE.Vector3();
    var quaternion = new THREE.Quaternion();
    var translation = new THREE.Vector3();
    var scale = new THREE.Vector3();
    var shootAngle = new THREE.Vector3();
    var lastNext = new THREE.Vector3();

    return function (time, delta) {
      if (!this.active) { return; }

      var matrixWorld = this.obj.matrixWorld;
      matrixWorld.decompose(translation, quaternion, scale);

      var direction = shootAngle.set(0, 0, -1)
        .applyQuaternion(quaternion).normalize();
      this.line.setDirection(direction.clone());
      p0.copy(translation); //this.obj.position);

      var last = p0.clone();
      var next;

      // Set default status as non-hit
      this.teleportEntity.setAttribute('visible', true);
      this.line.material.color.set(this.curveMissColor);
      this.hitEntity.setAttribute('visible', false);
      this.hit = false;

      if (this.data.type === 'parabolic') {
        var v0 = direction.clone().multiplyScalar(this.data.curveShootingSpeed);
        var g = -9.8;
        var a = new THREE.Vector3(0, g, 0);

        for (var i = 0; i < this.line.numPoints; i++) {
          var t = i / (this.line.numPoints - 1);
          next = parabolicCurve(p0, v0, a, t);
          // Update the raycaster with the length of the current segment last->next
          var dirLastNext = lastNext.copy(next).sub(last).normalize();
          this.raycaster.far = dirLastNext.length();
          this.raycaster.set(last, dirLastNext);

          if (this.checkMeshCollision(i, next)) { break; }
          last.copy(next);
        }
      } else if (this.data.type === 'line') {
        next = last.add(direction.clone().multiplyScalar(this.data.maxLength));
        this.raycaster.far = this.data.maxLength;

        this.raycaster.set(p0, direction);
        this.line.setPoint(0, p0);

        this.checkMeshCollision(1, next);
      }
    };
  })(),

  checkMeshCollision: function (i, next) {
    // The original function only returned true/false;
    // and for parabolic arc, each segment is checked until true.
    // So we were able to go through walls if a segment AFTER THAT ONE hit collisionEntity!
    // To fix that, change to tri-state return:
    //  0 = no intersection
    //  1 = hit collisionEntity
    // -1 = hit something else (so stop checking) -- this is what was missing.

    // Check if we intersected with any objects.
    var collisionEntity = this.data.collisionEntity;
    var collisionEntityIsFirst = false;
    var intersects;
    if (collisionEntity) {
      intersects = this.raycaster.intersectObjects(this.objects, true);
      // Only keep intersections against objects that have a reference to an entity.
      intersects = intersects.filter(function hasEl (intersection) { return !!intersection.object.el; });
      collisionEntityIsFirst = intersects.length > 0 && collisionEntity === intersects[0].object.el;
    } else {
      intersects = this.raycaster.intersectObject(this.defaultPlane, true);
      collisionEntityIsFirst = intersects.length > 0;
    }
    // Check to see if we intersected the 'floor' *first*.
    if (intersects.length > 0) {
      var point = intersects[0].point;

      // fill the rest of the points with the hit point
      this.hitPoint.copy(intersects[0].point);
      for (var j = i; j < this.line.numPoints; j++) {
          this.line.setPoint(j, this.hitPoint);
      }

      // if we got something other than the collisionEntity,
      // or invalid valid angle, or already have a hit,
      // bail out early, don't count it!
      if (!collisionEntityIsFirst || !this.isValidNormalsAngle(intersects[0].face.normal) || this.hit) {
        return -1;
      }

      this.line.material.color.set(this.curveHitColor);
      this.hitEntity.setAttribute('position', point);
      this.hitEntity.setAttribute('visible', true);
      this.hit = true;
      return 1;
    } else {
      this.line.setPoint(i, next);
      return 0;
    }
  },

  isValidNormalsAngle: function (collisionNormal) {
    var angleNormals = this.referenceNormal.angleTo(collisionNormal);
    return (THREE.Math.RAD2DEG * angleNormals <= this.data.landingMaxAngle);
  },

  createLine: function () {
    var numPoints = this.data.type === 'line' ? 2 : this.data.curveNumberPoints;
    this.line = new RayCurve(numPoints, this.data.curveLineWidth);
    this.teleportEntity.setObject3D('mesh', this.line.mesh);
  },

  createHitEntity: function () {
    var hitEntity = document.createElement('a-entity');
    hitEntity.className = 'hintEntity';

    var torus = document.createElement('a-entity');
    torus.setAttribute('geometry', {primitive: 'torus', radius: this.data.hitCylinderRadius, radiusTubular: 0.01});
    torus.setAttribute('rotation', {x: 90, y: 0, z: 0});
    torus.setAttribute('material', {shader: 'flat', color: this.data.hitCylinderColor, side: 'double', depthTest: false});
    hitEntity.appendChild(torus);

    var cylinder = document.createElement('a-entity');
    cylinder.setAttribute('geometry', {primitive: 'cylinder', segmentsHeight: 1, radius: this.data.hitCylinderRadius, height: this.data.hitCylinderHeight, openEnded: true});
    cylinder.setAttribute('position', {x: 0, y: this.data.hitCylinderHeight / 2, z: 0});
    cylinder.setAttribute('material', {shader: 'flat', color: this.data.hitCylinderColor, side: 'double', src: 'url(data:image/png;base64,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)', transparent: true, depthTest: false});
    hitEntity.appendChild(cylinder);

    this.el.sceneEl.appendChild(hitEntity);

    return hitEntity;
  },

  createDefaultPlane: function () {
    // @hack: Because I can't get three.bufferPlane working on raycaster
    var geometry = new THREE.BoxBufferGeometry(this.data.defaultPlaneSize, 0.5, this.data.defaultPlaneSize);
    geometry.applyMatrix(new THREE.Matrix4().makeTranslation(0, -0.25, 0));
    var material = new THREE.MeshBasicMaterial({color: 0xffff00});
    var box = new THREE.Mesh(geometry, material);
    return box;
  }
});
