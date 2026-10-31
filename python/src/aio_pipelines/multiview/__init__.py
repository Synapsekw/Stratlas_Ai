"""Multi-view vote: drafts of the same object seen from several photos become one draft (vision audit 3.6).

``vote.py`` holds the pure maths (cameras, clustering, the vote); ``scene.py`` reads a project's
photo poses and its mesh or point cloud and runs the vote over a draft pass (``vote_pass``).
"""
