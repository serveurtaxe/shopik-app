import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCategoryPathIds, superDepartmentId, departmentId, groupId, subGroupId } from '../../server/api/comax_product/categoryIds.js'

describe('comax category ids', () => {
    it('keeps the same code distinct across levels', () => {
        assert.notEqual(superDepartmentId('9'), departmentId('9'))
        assert.notEqual(departmentId('13'), superDepartmentId('13'))
        assert.notEqual(groupId('3006'), subGroupId('3006'))
    })

    it('builds positional path ids with the leaf last', () => {
        assert.deepEqual(
            buildCategoryPathIds({
                superDepartmentCode: '9',
                departmentCode: '904',
                groupCode: '9142',
                subGroupCode: '92410'
            }),
            ['sd:9', 'd:904', 'g:9142', 'sg:92410']
        )
    })

    it('omits a missing sub-group without shifting the other levels', () => {
        assert.deepEqual(
            buildCategoryPathIds({
                superDepartmentCode: '4',
                departmentCode: '404',
                groupCode: '4041'
            }),
            ['sd:4', 'd:404', 'g:4041']
        )
    })
})
