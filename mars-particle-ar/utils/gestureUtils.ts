// Define the interface locally since we are loading the library globally
export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export enum GestureType {
  NONE = 'NONE',
  OPEN_PALM = 'OPEN_PALM',
  PINCH = 'PINCH',
  FIST = 'FIST',
  POINTING = 'POINTING',
  THUMB_UP = 'THUMB_UP', // Reserved but might not be primary for Saturn
}

// Finger indices based on MediaPipe Hands topology
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_TIP = 12;
const RING_TIP = 16;
const PINKY_TIP = 20;

const THUMB_IP = 3;
const INDEX_PIP = 6;
const MIDDLE_PIP = 10;
const RING_PIP = 14;
const PINKY_PIP = 18;

const distance = (p1: NormalizedLandmark, p2: NormalizedLandmark): number => {
  return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
};

const isFingerExtended = (landmarks: NormalizedLandmark[], tipIdx: number, pipIdx: number): boolean => {
  const wrist = landmarks[WRIST];
  const tip = landmarks[tipIdx];
  const pip = landmarks[pipIdx];
  // Tip must be further from wrist than PIP is from wrist
  return distance(wrist, tip) > distance(wrist, pip);
};

export const detectGesture = (landmarks: NormalizedLandmark[]): GestureType => {
  if (!landmarks || landmarks.length < 21) return GestureType.NONE;

  const thumbExtended = isFingerExtended(landmarks, THUMB_TIP, THUMB_IP);
  const indexExtended = isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP);
  const middleExtended = isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP);
  const ringExtended = isFingerExtended(landmarks, RING_TIP, RING_PIP);
  const pinkyExtended = isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP);

  const pinchDist = distance(landmarks[THUMB_TIP], landmarks[INDEX_TIP]);
  
  // 1. PINCH: Thumb and Index very close
  if (pinchDist < 0.04) {
    return GestureType.PINCH;
  }

  // 2. FIST: All fingers curled. 
  // Strict check: Index, Middle, Ring, Pinky must be curled.
  if (!indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
     return GestureType.FIST;
  }

  // 3. POINTING: Index extended, others curled
  if (indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
    return GestureType.POINTING;
  }

  // 4. OPEN PALM: All fingers extended
  if (indexExtended && middleExtended && ringExtended && pinkyExtended) {
    // Thumb usually extended too, but let's be lenient
    return GestureType.OPEN_PALM;
  }
  
  // 5. Thumb Up (Optional, if needed for other logic)
  if (thumbExtended && !indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
      return GestureType.THUMB_UP;
  }

  return GestureType.NONE;
};