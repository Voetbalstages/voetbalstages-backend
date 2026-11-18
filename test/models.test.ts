import { describe, expect, it } from 'vitest'
import * as models from '../src/db/models/index.js'

describe('legacy collection names', () => {
  it('resolve to the same collections the old backend uses', () => {
    expect({
      users: models.Users.collection.collectionName,
      students: models.Students.collection.collectionName,
      camps: models.Camps.collection.collectionName,
      locations: models.Locations.collection.collectionName,
      organizations: models.Organizations.collection.collectionName,
      registrations: models.Registrations.collection.collectionName,
      payments: models.Payments.collection.collectionName,
      settings: models.SettingsModel.collection.collectionName,
      activity: models.Activities.collection.collectionName
    }).toEqual({
      users: 'users',
      students: 'students',
      camps: 'camps',
      locations: 'locations',
      organizations: 'organizations',
      registrations: 'registrations',
      payments: 'payments',
      settings: 'settings',
      activity: 'activities'
    })
  })

  it('never builds indexes on legacy collections', () => {
    for (const model of [models.Users, models.Students, models.Camps, models.Registrations, models.Payments]) {
      expect(model.schema.get('autoIndex')).toBe(false)
    }
  })
})
