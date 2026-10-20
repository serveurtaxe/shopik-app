export const MAX_FLOOR_WITHOUT_ELEVATOR = 4

export function isElevatorRequired({ floor, hasElevator } = {}) {
    if (hasElevator !== false) return false
    const floorNumber = parseInt(String(floor ?? '').trim(), 10)
    return Number.isFinite(floorNumber) && floorNumber > MAX_FLOOR_WITHOUT_ELEVATOR
}
