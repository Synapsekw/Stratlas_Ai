import numpy as np
import pytest

from aio_pipelines.engineer.cameras import Camera, read_cameras


def test_projection_uses_calibrated_rotation_and_cloud_offset_once(tmp_path):
    xml = tmp_path / "cameras.xml"
    xml.write_text("""<BlocksExchange><SpatialReferenceSystems><SRS><Id>1</Id><Definition>EPSG:32640</Definition></SRS></SpatialReferenceSystems>
    <Block><SRSId>1</SRSId><Photogroups><Photogroup><ImageDimensions><Width>1000</Width><Height>800</Height></ImageDimensions>
    <FocalLength>10</FocalLength><SensorSize>10</SensorSize><PrincipalPoint><x>500</x><y>400</y></PrincipalPoint>
    <Photo><ImagePath>old/one.jpg</ImagePath><Pose><Center><x>500000</x><y>3200000</y><z>50</z></Center>
    <Rotation><M_00>1</M_00><M_01>0</M_01><M_02>0</M_02><M_10>0</M_10><M_11>-1</M_11><M_12>0</M_12><M_20>0</M_20><M_21>0</M_21><M_22>-1</M_22></Rotation>
    </Pose></Photo></Photogroup></Photogroups></Block></BlocksExchange>""")
    photos = [tmp_path / "one.jpg"]
    cameras = read_cameras(xml, photos, [500000, 3200000, 10], -32.542, {"epsg": 32640})
    assert len(cameras) == 1
    c = cameras[0]
    np.testing.assert_allclose(c.centre, [0, 7.458, 0])
    # Raw ENH point [500001,3200002,40], converted using the same cloud offset.
    pixel = c.project(np.array([[1, -2.542, -2]]))
    np.testing.assert_allclose(pixel, [[600, 200]], atol=1e-8)
    with pytest.raises(ValueError, match="coordinate system"):
        read_cameras(xml, photos, [0, 0, 0], 0, {"epsg": 32639})


def test_points_behind_camera_are_not_usable_crops():
    c = Camera("a.jpg", np.zeros(3), np.eye(3), 1000, 800, 1000, 1000, 500, 400, [0] * 5)
    assert np.isnan(c.project(np.array([[0, 0, -1]]))).all()
